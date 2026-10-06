# Good and Bad Tests

## Good tests

Test observable behavior through a real interface:

```ts
test("valid input is accepted", async () => {
  const result = await submitForm({ field: "known value" });
  expect(result.status).toBe("accepted");
});
```

Good tests describe what callers care about, use public APIs, survive internal refactors, and make one logical assertion.

## Bad tests

Implementation-detail tests mock internal collaborators, test private methods, assert call counts or order, or name how the code works instead of what it does.

```ts
test("submits through the internal helper", async () => {
  const helper = mockInternalHelper();
  await submitForm({ field: "known value" });
  expect(helper).toHaveBeenCalled();
});
```

Do not bypass the interface to verify storage. Call the public read operation instead.

Tautological tests recompute the expected value with the implementation's algorithm. Use an independent known literal:

```ts
test("totals line items", () => {
  expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15);
});
```
