# When to Mock

Mock at system boundaries only:

- external APIs
- databases when a test database is not practical
- time and randomness
- the file system when isolation is required

Do not mock your own classes or internal collaborators.

## Designing for mockability

Use dependency injection. Pass external dependencies into the operation instead of creating them inside it:

```ts
function processCharge(record, billingClient) {
  return billingClient.charge(record.total);
}
```

Prefer specific SDK-style operations over one generic fetcher. Each operation should have one predictable result shape and one independently mockable boundary. This avoids conditional logic in test setup, makes exercised operations visible, and keeps types specific to each operation.
