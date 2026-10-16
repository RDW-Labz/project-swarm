export function mapKeys(items, startAt) {
  const ids = new Map();
  const errors = [];
  let n = startAt;
  let index = 0;
  for (const item of items) {
    index++;
    const key = item == null ? undefined : item.key;
    if (typeof key !== 'string' || key.length === 0) {
      errors.push('item ' + index + ': key must be a non-empty string');
      continue;
    }
    if (ids.has(key)) {
      errors.push('item ' + index + ': duplicate key: ' + key);
      continue;
    }
    ids.set(key, 'T-' + String(n).padStart(4, '0'));
    n++;
  }
  return { ids, errors };
}
