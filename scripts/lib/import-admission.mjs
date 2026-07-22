import fs from 'node:fs';
import path from 'node:path';

export const ADMISSION_TIME_ZONE = 'Asia/Tokyo';

function calendarDay(value, timeZone = ADMISSION_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new Error('invalid admission timestamp');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Prevent two different catalog admission waves on one project-local day. */
export function assertAdmissionDayAvailable(root, plan, now = new Date()) {
  const day = calendarDay(now);
  const receiptsDir = path.join(path.resolve(root), 'data', 'imports');
  if (!fs.existsSync(receiptsDir)) return;
  for (const name of fs.readdirSync(receiptsDir).filter((entry) => entry.endsWith('.json')).sort()) {
    const receipt = JSON.parse(fs.readFileSync(path.join(receiptsDir, name), 'utf8'));
    if (typeof receipt?.batchId !== 'string' || !Number.isFinite(Date.parse(receipt?.appliedAt ?? ''))) {
      throw new Error(`invalid import receipt while checking admission day: ${name}`);
    }
    if (receipt.batchId === plan?.batchId) {
      if (typeof plan?.batchDigest === 'string' && receipt.batchDigest === plan.batchDigest) continue;
      const error = new Error(`import batch id ${receipt.batchId} is already bound to another digest`);
      error.code = 'BATCH_ID_REUSED';
      throw error;
    }
    if (calendarDay(receipt.appliedAt) === day) {
      const error = new Error(
        `catalog admission day ${day} is already occupied by ${receipt.batchId}; `
          + 'run this batch on the next project-local day',
      );
      error.code = 'ADMISSION_DAY_OCCUPIED';
      error.existingBatchId = receipt.batchId;
      throw error;
    }
  }
}

/** A sealed receipt must describe the same local day as its fast-forward. */
export function assertAdmissionReceiptDay(receipt, now = new Date()) {
  const receiptDay = calendarDay(receipt?.appliedAt);
  const promotionDay = calendarDay(now);
  if (receiptDay === promotionDay) return;
  const error = new Error(
    `sealed import receipt day ${receiptDay} does not match promotion day ${promotionDay}; `
      + 'abort and rebuild the batch so appliedAt records the actual admission day',
  );
  error.code = 'ADMISSION_RECEIPT_DAY_STALE';
  throw error;
}
