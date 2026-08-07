/** Erfolgs-/Fehlermeldungen aus den Query-Parametern ?ok= / ?error= / ?warn=. */
export function Toasts({
  ok,
  error,
  warn,
  info,
}: {
  ok?: string;
  error?: string;
  warn?: string;
  info?: string;
}) {
  if (!ok && !error && !warn && !info) return null;
  return (
    <div className="space-y-3 mb-6">
      {ok && <div className="toast-ok">{decodeURIComponent(ok)}</div>}
      {error && <div className="toast-error">{decodeURIComponent(error)}</div>}
      {warn && <div className="toast-warn">{decodeURIComponent(warn)}</div>}
      {info && <div className="toast-info">{decodeURIComponent(info)}</div>}
    </div>
  );
}
