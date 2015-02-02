/*
 * Cloud Foundry Services Connector
 * Copyright (c) 2014 ActiveState Software Inc. All rights reserved.
 *
 *   Licensed under the Apache License, Version 2.0 (the "License");
 *   you may not use this file except in compliance with the License.
 *   You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *   Unless required by applicable law or agreed to in writing, software
 *   distributed under the License is distributed on an "AS IS" BASIS,
 *   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *   See the License for the specific language governing permissions and
 *   limitations under the License.
 */

'use strict';

var Broker = require('cf-services-connector');
var Config = require('./config/aws-rds-service-broker');
var Handlebars = require('handlebars');
var async = require('async');
var broker = new Broker(Config);

var AWS = require('aws-sdk');
AWS.config.region = Config.aws.Region;
var rds = new AWS.RDS();
var iam = new AWS.IAM();


function checkConsistency() {
    var i, p;
    for (i = 0; i < Config.services.length; i += 1) {
        for (p = 0; p < Config.services[i].plans.length; p += 1) {
            if (!Config.plans.hasOwnProperty(Config.services[i].plans[p].id)) {
                console.log("ERROR: plan '" + Config.services[i].plans[p].name + "' of service '" + Config.services[i].name + "' is missing a specification.");
                process.exit(1);
            }
        }
    }
}

checkConsistency();
broker.start();


function generatePassword(passwordLength) {
    var i = 0,
        result = "",
        possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    for (i = 0; i < passwordLength; i += 1) {
        result += possible.charAt(Math.floor(Math.random() * possible.length));
    }

    return result;
}


function getAllDbInstances(filter, functionCallback) {
    var RdsArnPrefix = null,
        AwsAccountId = null,
        dbInstances = [];

    function addTagsToDBInstances(dbinstance, callback) {
        rds.listTagsForResource({
                'ResourceName': RdsArnPrefix + dbinstance.DBInstanceIdentifier
            },
            function (err, tags) {
                if (err) {
                    callback(err, null);
                } else {
                    if (tags) {
                        dbinstance.TagList = tags.TagList;
                    } else {
                        dbinstance.TagList = [];
                    }
                    callback(null, dbinstance);
                }
            });
    }

    async.series([
            // Get AwsAccountId and RdsArnPrefix
            function (callback) {
                iam.getUser({}, function (err, data) {
                    var user = data.User,
                        colon = new RegExp(":");
                    if (err) {
                        callback(err, []);
                    } else {
                        AwsAccountId = user.Arn.split(colon)[4];
                        RdsArnPrefix = 'arn:aws:rds:' + Config.aws.Region + ':' + AwsAccountId + ':db:';
                        callback(null, user);
                    }
                });
            },

            // Get All RdsInstances
            function (callback) {
                var i = 0;

                rds.describeDBInstances({}).eachPage(function (err, page, done) {
                    if (err) {
                        callback(err, null);
                    } else if (page) {
                        if (page.DBInstances && page.DBInstances.length > 0) {
                            async.mapLimit(page.DBInstances, 2, addTagsToDBInstances, function (err, results) {
                                if (err) {
                                    callback(err, null);
                                } else {
                                    filter.filter(results, function (err, matches) {
                                        if (err) {
                                            callback(err, null);
                                        } else {
                                            for (i = 0; i < matches.length; i += 1) {
                                                dbInstances.push(matches[i]);
                                            }
                                            done();
                                        }
                                    });
                                }
                            });
                        } else {
                            done();
                        }
                    } else {
                        callback(null, dbInstances);
                    }
                });
            }
        ],
        function (err) {
            functionCallback(err, dbInstances);
        });
}

// filter to match on service instance id
function DbInstanceIdFilter(id) {
    this.filter = function (dbinstances, callback) {
        function matchInstanceIdTag(tag, callback) {
            callback(tag.Key === 'CF-AWS-RDS-INSTANCE-ID' && tag.Value === id);
        }

        function match(instance, callback) {
            async.filter(instance.TagList, matchInstanceIdTag, function (resultingArray) {
                callback(resultingArray.length > 0);
            });
        }

        async.filter(dbinstances, match, function (matchingDbInstances) {
            callback(null, matchingDbInstances);
        });
    };
}

// filter to select all of the  dbinstances
function DbInstanceNoFilter() {
    this.filter = function (dbinstances, callback) {
        callback(null, dbinstances);
    };
}

// filter to select all of dbinstances matching service, plan, organization and space.
function DbInstanceParameterFilter(params) {
    this.service_id = params.service_id;
    this.plan_id = params.plan_id;
    this.organization_guid = params.organization_guid;
    this.space_guid = params.space_guid;

    this.filter = function (dbinstances, callback) {

        function match(instance, callback) {
            var i, tag, serviceMatch = false,
                planMatch = false,
                orgMatch = false,
                spaceMatch = false;

            for (i = 0; i < instance.TagList.length; i += 1) {
                tag = instance.TagList[i];
                serviceMatch = serviceMatch || (tag.Key === 'CF-AWS-RDS-SERVICE-ID' && tag.Value === params.service_id);
                planMatch = planMatch || (tag.Key === 'CF-AWS-RDS-PLAN-ID' && tag.Value === params.plan_id);
                orgMatch = orgMatch || (tag.Key === 'CF-AWS-RDS-ORG-ID' && tag.Value === params.organization_guid);
                spaceMatch = spaceMatch || (tag.Key === 'CF-AWS-RDS-SPACE-ID' && tag.Value === params.space_guid);
            }
            callback(serviceMatch && planMatch && orgMatch && spaceMatch);
        }

        async.filter(dbinstances, match, function (matchingDbInstances) {
            callback(null, matchingDbInstances);
        });
    };
}


function generateInstanceId(prefix) {
    return prefix.concat('-').concat((Math.floor(Date.now() / 100, 0).toString(16)));
}

function createDashboardUrl(params) {
    var dashboardUrl = Handlebars.compile('https://{{region}}.console.aws.amazon.com/rds/home?region={{region}}#dbinstance:id={{id}}');
    return {
        dashboard_url: dashboardUrl({
            region: AWS.config.region,
            id: params.DBInstanceIdentifier
        })
    };
}

function createRds(req, plan, next) {
    var reply = {},
        params = JSON.parse(JSON.stringify(plan));

    params.DBInstanceIdentifier = generateInstanceId(plan.DBInstanceIdentifier);
    params.MasterUserPassword = generatePassword(12);
    params.DBSubnetGroupName = Config.aws.DBSubnetGroupName;

    params.Tags = [{
        'Key': 'CF-AWS-RDS-SERVICE-ID',
        'Value': req.params.service_id
    }, {
        'Key': 'CF-AWS-RDS-PLAN-ID',
        'Value': req.params.plan_id
    }, {
        'Key': 'CF-AWS-RDS-ORG-ID',
        'Value': req.params.organization_guid
    }, {
        'Key': 'CF-AWS-RDS-SPACE-ID',
        'Value': req.params.space_guid
    }, {
        'Key': 'CF-AWS-PASSWORD',
        'Value': params.MasterUserPassword
    }, {
        'Key': 'CF-AWS-RDS-INSTANCE-ID',
        'Value': req.params.id
    }];

    getAllDbInstances(new DbInstanceIdFilter(req.params.id), function (err, dbInstances) {
        if (!err) {
            if (dbInstances && dbInstances.length > 0) {
                reply = createDashboardUrl(dbInstances[0]);
                reply.exists = true;
                next(reply);
            } else {
                rds.createDBInstance(params, function (err) {
                    if (!err) {
                        reply = createDashboardUrl(params);
                        next(reply);
                    } else {
                        throw new Error(err);
                    }
                });
            }
        } else {
            throw new Error(err);
        }
    });
}

broker.on('provision', function (req, next) {
    if (Config.plans.hasOwnProperty(req.params.plan_id)) {
        createRds(req, Config.plans[req.params.plan_id], next);
    } else {
        throw new Error("plan " + req.params.plan_id + " is missing in the service broker configuration.");
    }
});

broker.on('unprovision', function (req, next) {
    getAllDbInstances(new DbInstanceIdFilter(req.params.id), function (err, dbInstances) {
        var dbinstance = dbInstances[0],
            params = {
                DBInstanceIdentifier: dbinstance.DBInstanceIdentifier
            };

        if (!err) {
            if (dbInstances && dbInstances.length > 0) {
                if (dbinstance.DBInstanceStatus !== "creating") {
                    params.FinalDBSnapshotIdentifier = ('Final-snapshot-' + dbinstance.DBInstanceIdentifier);
                    params.SkipFinalSnapshot = false;
                } else {
                    params.SkipFinalSnapshot = true;
                }

                rds.deleteDBInstance(params, function (err, rdsResponse) {
                    if (!err) {
                        console.log(rdsResponse);
                        next();
                    } else {
                        throw new Error(err);
                    }
                });
            } else {
                console.log("warning: service id not in database.");
                next();
            }
        } else {
            throw new Error(err);
        }
    });
});


broker.on('bind', function (req, next) {
    var reply = {};

    getAllDbInstances(new DbInstanceIdFilter(req.params.instance_id), function (err, dbInstances) {
        var i = 0,
            dbinstance = null,
            tag = null;
        if (!err) {
            if (dbInstances && dbInstances.length > 0) {
                dbinstance = dbInstances[0];
                if (dbinstance && dbinstance.Endpoint) {
                    reply.credentials = {
                        'host': dbinstance.Endpoint.Address,
                        'username': dbinstance.MasterUsername,
                        'port': dbinstance.Endpoint.Port
                    };
                    for (i = 0; i < dbinstance.TagList.length; i += 1) {
                        tag = dbinstance.TagList[i];
                        if (tag.Key === 'CF-AWS-PASSWORD') {
                            reply.credentials.password = tag.Value;
                        }
                    }
                    next(reply);
                } else {
                    throw new Error("No endpoint set on the instance '" + dbinstance.DBInstanceIdentifier + "'. The instance is in state '" + dbinstance.DBInstanceStatus + "'.");
                }
            } else {
                throw new Error("database instance has been deleted.");
            }
        } else {
            throw new Error(err);
        }

    });
});

broker.on('unbind', function (req, next) {
    console.log(req);
    next({});
});
