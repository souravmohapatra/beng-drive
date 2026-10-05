// One server process owns this setting. Keep the public closed path free of DB/NAS work.
export function createIntakeWindow(db, clock = Date.now) {
  let closesAt = db?.prepare('SELECT closes_at FROM intake_window WHERE id=1').get()?.closes_at ?? null;
  let deadline = closesAt === null ? 0 : Date.parse(closesAt);
  const status = () => {
    const now = clock();
    return { open: Number.isFinite(deadline) && deadline > now, closesAt, serverNow: new Date(now).toISOString() };
  };
  return {
    isOpen: () => Number.isFinite(deadline) && deadline > clock(),
    status,
    update(data) {
      const value = data?.closesAt;
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 1 ||
          !(value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
          Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value && Date.parse(value) > clock()))) {
        throw Object.assign(new Error('INVALID_INTAKE_WINDOW'), { status: 400, code: 'INVALID_INTAKE_WINDOW' });
      }
      db.prepare('UPDATE intake_window SET closes_at=? WHERE id=1').run(value);
      closesAt = value;
      deadline = value === null ? 0 : Date.parse(value);
      return status();
    },
  };
}
