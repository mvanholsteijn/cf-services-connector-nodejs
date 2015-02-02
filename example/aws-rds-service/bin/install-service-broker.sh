#!/bin/bash


function getRoutesUrl() {
	[ -z "$1" ] && echo ERROR: missing application name >&2 &&  exit 1
	stackato app $1 --json | grep -v ^SSL |  jq -r '.entity.routes_url'
}


function getDomainUrlOfFirstRoute() {
	[ -z "$1" ] && echo ERROR: missing routes url >&2 &&  exit 1
	stackato curl GET $1 | grep -v ^SSL | jq -r '.resources[0].entity.domain_url'
}

function getHostOfFirstRoute() {
	[ -z "$1" ] && echo ERROR: missing routes url >&2 &&  exit 1
	stackato curl GET $1 | grep -v ^SSL | jq -r '.resources[0].entity.host'
}

function getDomainName() {
	[ -z "$1" ] && echo ERROR: missing domain url >&2 &&  exit 1
	stackato curl GET $1 | grep -v ^SSL | jq -r .entity.name
}

function getServicePlanUrlForUuid() {
	[ -z "$1" ] && echo ERROR: plan id is missing  >&2 &&  exit 1
	 stackato curl GET /v2/service_plans | grep -v ^SSL | \
		jq -r ".resources[] | select(.entity.unique_id == \"$1\") | .metadata.url "
}

function getFirstRoute() {
	ROUTES_URL=$(getRoutesUrl $1)
	DOMAIN_URL=$(getDomainUrlOfFirstRoute $ROUTES_URL)
	HOSTNAME=$(getHostOfFirstRoute $ROUTES_URL)
	DOMAIN=$(getDomainName $DOMAIN_URL)

	echo $HOSTNAME.$DOMAIN
}

function makeAllPlansPublic() {
	SERVICES=$(jq -r ".services[] | .name"  config/$1.json)
	if [ -n "$SERVICES" ] ; then
		for SERVICE in $SERVICES; do
			PLANS=$(jq -r ".services[] | select(.name==\"$SERVICE\") | .plans[] | .id"  config/$1.json)
			if [ -n "$PLANS" ] ; then
				for PLAN in $PLANS ; do 
						SERVICEPLAN_URL=$(getServicePlanUrlForUuid $PLAN)
						if [ -n "$SERVICEPLAN_URL" ] ; then
							stackato curl PUT $SERVICEPLAN_URL -d '{"public" : true }'
						else
							echo "WARN: plan '$PLAN' of service '$SERVICE' is not registered." 2>&1
						fi
				done
			else
				echo "WARN: no plans found for service $SERVICE in config/$1.json" 2>&1
			fi
		done
	else
		echo "WARN: No services defined in config/$1.json" 2>&1
	fi
}

function checkServiceBroker() {
  stackato curl GET /v2/service_brokers | grep -v ^SSL | jq  -r ".resources[] | select(.entity.name==\"$1\") | .entity.name"
}

function installServiceBroker() {
	stackato push --as $1
	USER=$(jq -r ".authUser" config/$1.json )
	PWD=$(jq -r ".authPassword" config/$1.json)

	if [ -z "$(checkServiceBroker $1)"  ] ; then
		stackato create-service-broker \
			--username $USER \
			--password $PWD \
			--url $(getFirstRoute) \
			$1
	else
		echo "WARN: a service broker named '$1' already exists." >&2
	fi
}

installServiceBroker aws-rds-service-broker
makeAllPlansPublic aws-rds-service-broker
