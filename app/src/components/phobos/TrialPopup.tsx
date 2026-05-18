import { useState, useEffect } from 'react';
import { LicenseDialog } from './LicenseDialog';

export function TrialPopup({ onDismiss }: { onDismiss: () => void }) {
  const [secondsLeft, setSecondsLeft] = useState(15);
  const [licenseOpen, setLicenseOpen] = useState(false);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  return (
    <>
      <div className="fixed inset-0 z-[300] bg-black/95 flex items-center justify-center">
        <div className="max-w-md w-full mx-6 text-center">
          <img src={`${import.meta.env.BASE_URL}phobos.png`} alt="PHOBOS" className="w-24 h-24 mx-auto mb-6 opacity-60" />
          <h2 className="text-xl font-terminal text-phobos-green/80 tracking-[0.2em] mb-2">
            Welcome to PHOBOS
          </h2>
          <p className="text-sm text-muted-foreground/60 mb-8 leading-relaxed">
            This software is free to use. If you find it valuable,
            please consider supporting development.
          </p>

          {/* Countdown */}
          <div className="mb-8">
            {secondsLeft > 0 ? (
              <div className="text-4xl font-terminal text-phobos-green/60 tabular-nums">
                {secondsLeft}
              </div>
            ) : (
              <button
                onClick={onDismiss}
                className="px-8 py-3 border border-phobos-green/40 text-phobos-green font-terminal text-sm tracking-[0.15em] rounded-sm hover:bg-phobos-green/10 hover:shadow-[0_0_20px_hsl(120_100%_50%/0.1)] transition-all"
              >
                CONTINUE TO PHOBOS
              </button>
            )}
          </div>

          <div className="space-y-3">
            <button
              onClick={() => setLicenseOpen(true)}
              className="block mx-auto px-6 py-2 border border-phobos-green/25 text-phobos-green/60 font-terminal text-[10px] tracking-[0.15em] rounded-sm hover:text-phobos-green hover:border-phobos-green/40 transition-all"
            >
              BECOME A PATRON
            </button>
            <button
              onClick={() => setLicenseOpen(true)}
              className="text-[10px] text-muted-foreground/30 hover:text-muted-foreground/50 transition-colors font-mono"
            >
              Upload Certificate
            </button>
          </div>
        </div>
      </div>

      {licenseOpen && (
        <LicenseDialog
          onClose={() => setLicenseOpen(false)}
          onLicensed={() => {
            localStorage.setItem('phobos_licensed', 'true');
            setLicenseOpen(false);
            onDismiss();
          }}
        />
      )}
    </>
  );
}
