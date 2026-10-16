export function mapKeys(items, startAt) {
  const ids = {};
  const errors = [];
  let n = startAt;
  for (const item of items) {
    const key = item.key;
    ids[key] = 'T-' + String(n).padStart(4, '0');
    n++;
  }
  return { ids, errors };
}
