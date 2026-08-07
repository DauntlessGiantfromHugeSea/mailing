export function Logo({ className = "h-8 w-auto" }: { className?: string }) {
  return (
    <span className={"inline-flex items-center gap-2 " + className}>
      <svg viewBox="0 0 32 32" className="h-full w-auto" aria-hidden="true">
        <defs>
          <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="rgb(0,142,144)" />
            <stop offset="100%" stopColor="rgb(0,100,102)" />
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#lg)" />
        <path
          d="M8 12.5 L16 18 L24 12.5"
          fill="none"
          stroke="white"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <rect x="8" y="10" width="16" height="12" rx="2.5" fill="none" stroke="white" strokeWidth="2" />
      </svg>
      <span className="font-semibold tracking-tight text-slate-800 text-[15px]">Mailing</span>
    </span>
  );
}
