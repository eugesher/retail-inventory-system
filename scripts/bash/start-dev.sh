#!/usr/bin/env bash
set -euo pipefail

reload=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reload|-r)
      reload=true
      shift
      ;;
    *)
      shift
      ;;
  esac
done

if [[ "$reload" == true ]]; then
  yarn test:infra:reload
fi

concurrently \
  --names "API,INV,RET,NOT,CAT" \
  --prefix "[{name}]" \
  --prefix-colors "magenta,blue,cyan,yellow,green" \
  "yarn start:dev:api-gateway" \
  "yarn start:dev:inventory-microservice" \
  "yarn start:dev:retail-microservice" \
  "yarn start:dev:notification-microservice" \
  "yarn start:dev:catalog-microservice"
