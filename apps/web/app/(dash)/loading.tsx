/**
 * Shown at once on every navigation inside the dashboard while the page's
 * data loads on the server. Links prefetch this shell, so a click responds
 * immediately instead of waiting for the database.
 */
export default function Loading() {
  const bar = "rounded-[10px] bg-surface-2 animate-pulse";
  return (
    <div aria-busy="true" aria-live="polite" className="space-y-4">
      <span className="sr-only">جارٍ التحميل…</span>
      <div className={`${bar} h-7 w-48`} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card p-4">
            <div className={`${bar} mb-3 h-3 w-20`} />
            <div className={`${bar} h-6 w-14`} />
          </div>
        ))}
      </div>
      <div className="card p-4">
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={`${bar} mb-3 h-4 last:mb-0`}
            style={{ width: `${90 - i * 9}%` }}
          />
        ))}
      </div>
    </div>
  );
}
