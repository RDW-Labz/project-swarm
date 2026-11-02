# API notes for the vehicle lookup contract

The contract tooling reads one OpenAPI 3 document in JSON form at contracts/api.json. It does not read YAML or TypeScript files, so do not write those.

Operations:
- GET /api/vin, operationId decodeVin. Query parameter vin is required and is a string. Response 200 returns VinResult.
- POST /api/requests, operationId submitRequest. Request body is SubmitInput. Response 200 returns SubmitResult.

Schemas (components.schemas):
- VinResult: found (boolean, required), make (string), model (string).
- SubmitInput: vin, contactName, contactPhone (all strings, all required).
- SubmitResult: ok (boolean, required), requestNumber (integer, minimum 1, required).

Use only local refs of the form #/components/schemas/Name. Every path needs an operationId.
