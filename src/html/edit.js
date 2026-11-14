import { ClayError } from '../errors.js';

const MAX_EDITS = 50;
const OFFSET_SAMPLE = 5;

function invalid(message, hint) {
  return new ClayError('invalid-edits', message, { hint });
}

function locate(html, needle, limit = Infinity) {
  const offsets = [];
  let from = 0;
  while (offsets.length < limit) {
    const start = html.indexOf(needle, from);
    if (start === -1) break;
    offsets.push(start);
    from = start + 1;
  }
  return offsets;
}

function checkShape(edits) {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > MAX_EDITS) {
    throw invalid(
      `\`edits\` must hold between 1 and ${MAX_EDITS} edits.`,
      'Pass an array of `{ find, replace }` objects, optionally with a 1-based `occurrence`.',
    );
  }
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
      throw invalid('Each edit must be an object with `find` and `replace`.', 'Pass `{ find, replace }`.');
    }
    if (typeof edit.find !== 'string' || edit.find.length === 0) {
      throw invalid('Each edit needs a non-empty `find` string.', 'Copy the exact text from a read.');
    }
    if (typeof edit.replace !== 'string') {
      throw invalid('Each edit needs a `replace` string.', 'Use an empty string to delete the text.');
    }
    if (edit.occurrence !== undefined && (!Number.isInteger(edit.occurrence) || edit.occurrence < 1)) {
      throw invalid('`occurrence` must be a whole number counting from 1.', 'Pass `occurrence: 2` for the second match.');
    }
  }
}

export function applyEdits(html, edits, { scanLimit = false } = {}) {
  checkShape(edits);
  const planned = [];
  for (let index = 0; index < edits.length; index += 1) {
    const edit = edits[index];
    const limit = scanLimit ? (edit.occurrence ?? 1) + 1 : Infinity;
    const offsets = locate(html, edit.find, limit);
    if (offsets.length === 0) {
      throw new ClayError('edit-not-found', `Edit ${index + 1} did not match any text.`, {
        hint: 'Read the document again and copy the text exactly, including whitespace.',
        details: { index },
      });
    }
    let offset;
    if (edit.occurrence === undefined) {
      if (offsets.length > 1) {
        const counted = scanLimit && offsets.length >= limit
          ? { count: offsets.length, atLeast: true }
          : { count: offsets.length };
        throw new ClayError(
          'edit-not-unique',
          `Edit ${index + 1} matches ${counted.atLeast ? 'at least ' : ''}${offsets.length} places, so it is ambiguous.`,
          {
            hint: 'Add surrounding text to `find` so it is unique, or pass `occurrence` to pick one.',
            details: { index, ...counted, offsets: offsets.slice(0, OFFSET_SAMPLE) },
          },
        );
      }
      offset = offsets[0];
    } else {
      if (edit.occurrence > offsets.length) {
        throw new ClayError(
          'edit-not-found',
          `Edit ${index + 1} asked for occurrence ${edit.occurrence}, but the text occurs ${offsets.length} times.`,
          {
            hint: 'Read the document again and count the occurrences, or drop `occurrence` when the text is unique.',
            details: { index },
          },
        );
      }
      offset = offsets[edit.occurrence - 1];
    }
    planned.push({ index, start: offset, end: offset + edit.find.length, replace: edit.replace });
  }
  for (let a = 0; a < planned.length; a += 1) {
    for (let b = a + 1; b < planned.length; b += 1) {
      const one = planned[a];
      const two = planned[b];
      if (one.start < two.end && two.start < one.end) {
        throw new ClayError('edits-overlap', `Edits ${one.index + 1} and ${two.index + 1} overlap.`, {
          hint: 'Give each edit its own non-overlapping text, or merge them into one edit.',
          details: { indexes: [one.index, two.index] },
        });
      }
    }
  }
  planned.sort((one, two) => two.start - one.start);
  let output = html;
  for (const edit of planned) {
    output = output.slice(0, edit.start) + edit.replace + output.slice(edit.end);
  }
  return { html: output, applied: planned.length };
}
