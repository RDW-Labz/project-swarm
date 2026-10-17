// Adaptive batch controller (design section 9). Pure, no dependencies.

const isPosInt = (v) => Number.isInteger(v) && v > 0;

function invalid(message) {
  const err = new Error(message);
  err.code = 'batch-controller-invalid';
  return err;
}

// Next size after a streak of passes. Below 25 go to 25, 25 to 50, above 50 double; never above max.
function stepUp(size, max) {
  const next = size < 25 ? 25 : size < 50 ? 50 : size * 2;
  return Math.min(max, next);
}

// Next size after a failed batch: 50+ to 25, 25+ to 10, below that halve (rounded up); never below min.
function stepDown(size, min) {
  let next;
  if (size >= 50) next = 25;
  else if (size >= 25) next = 10;
  else next = Math.ceil(size / 2);
  return Math.max(min, next);
}

export function createBatchController({ start = 10, min = 1, max = 100, streak = 3 } = {}) {
  if (![start, min, max, streak].every(isPosInt) || min > start || start > max) {
    throw invalid('batch controller options must be positive integers with min <= start <= max');
  }

  let size = start;
  let run = 0;
  const history = [];
  const steps = { up: 0, down: 0 };

  return {
    get size() {
      return size;
    },
    get history() {
      return history.slice();
    },
    record(passed) {
      history.push(size);
      if (passed) {
        run += 1;
        if (run >= streak) {
          run = 0;
          const next = stepUp(size, max);
          if (next !== size) {
            size = next;
            steps.up += 1;
          }
        }
      } else {
        run = 0;
        const next = stepDown(size, min);
        if (next !== size) {
          size = next;
          steps.down += 1;
        }
      }
      return size;
    },
    state() {
      return { size, streak: run, steps: { ...steps } };
    },
  };
}
