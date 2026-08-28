import { useRef } from 'react'
import type { ShotPlanShot } from '../types'

export type CaptureStatus = 'idle' | 'reviewing' | 'accepted' | 'rejected' | 'review_failed'

/**
 * The guided-capture screen — one requested shot dominates the screen at a
 * time (FOCUS > INFORMATION DENSITY). No live camera preview: capture goes
 * through the OS camera app via a file input's `capture` attribute, which is
 * far more reliable across mobile browsers than a custom getUserMedia view.
 *
 * The seller's own photo appears the INSTANT it's picked (pendingPreviewUrl,
 * a local ObjectURL created before any network request) and stays as the
 * full-bleed hero through reviewing/rejected/review_failed/accepted — never
 * a blank loading state, never a placeholder standing in for their photo.
 */
export function CaptureScreen({
  shot,
  shotNumber,
  totalShots,
  status,
  pendingPreviewUrl,
  rejection,
  reviewFailureCount,
  isPreparingPlan,
  acceptedPreviews,
  canSkip,
  onFileSelected,
  onRemoveAccepted,
  onRetryReview,
  onForceAccept,
  onSkip,
}: {
  shot: ShotPlanShot
  shotNumber: number
  totalShots: number
  status: CaptureStatus
  /** The current photo's local preview — set the instant a file is picked, well before the review request completes. */
  pendingPreviewUrl: string | null
  rejection: { reason: string | null; suggestion: string | null } | null
  /** How many times review-photo has failed (network/AI error, not a normal rejection) for the CURRENT pending photo — used to reveal the "Använd bilden ändå" escape hatch after repeated failures. */
  reviewFailureCount: number
  isPreparingPlan: boolean
  acceptedPreviews: string[]
  /** False only for the very first (frontal) shot — that one always stays required. */
  canSkip: boolean
  onFileSelected: (file: File) => void
  onRemoveAccepted: (index: number) => void
  /** Re-runs the review call on the same already-captured photo — used by the review_failed state's retry action. */
  onRetryReview: () => void
  /** Escape hatch: accept the pending photo without a successful review. Only ever shown after repeated review failures. */
  onForceAccept: () => void
  /** Skips the current (non-frontal) shot immediately — no confirmation, no guilt copy. */
  onSkip: () => void
}) {
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const galleryInputRef = useRef<HTMLInputElement>(null)
  const busy = status === 'reviewing'

  function handleFiles(list: FileList | null) {
    const file = list?.[0]
    if (file) onFileSelected(file)
  }

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col px-5 pt-6 pb-8 sm:min-h-[calc(100dvh-4rem)]">
      {/* Progress — quiet, elegant, never competing with the shot itself.
          Hidden for the very first (frontal) shot: the real total isn't known
          until the adaptive plan loads, so a "1/1" bar would misleadingly
          read as already complete. */}
      <div className="mx-auto flex h-1 w-full max-w-md items-center gap-2">
        {totalShots > 1 && (
          <>
            <div className="flex flex-1 gap-1">
              {Array.from({ length: totalShots }).map((_, i) => (
                <div
                  key={i}
                  className={`h-1 flex-1 rounded-full transition-colors ${i < shotNumber - 1 ? 'bg-[var(--color-accent)]' : i === shotNumber - 1 ? 'bg-[var(--color-ink)]' : 'bg-[var(--color-line)]'}`}
                />
              ))}
            </div>
            <span className="shrink-0 text-xs font-medium text-[var(--color-body)]">
              {shotNumber} / {totalShots}
            </span>
          </>
        )}
      </div>

      {/* Dominant element: the current shot — or, briefly after the first
          photo, an "adapting the guide" transition instead of re-showing an
          already-completed instruction. */}
      <div className="mx-auto mt-6 flex w-full max-w-md flex-1 flex-col items-center justify-center text-center">
        {isPreparingPlan ? (
          <>
            <div className="flex flex-col items-center gap-2 text-[var(--color-accent)]">
              <CheckCircleIcon />
              <span className="text-sm font-semibold text-[var(--color-ink)]">Bra bild</span>
            </div>
            <p className="mt-6 text-[15px] font-medium text-[var(--color-ink)]">Anpassar guiden till din produkt…</p>
          </>
        ) : (
          <>
            {!pendingPreviewUrl && (
              <>
                <h2 className="text-2xl font-bold tracking-tight text-[var(--color-ink)] sm:text-[28px]">{shot.title}</h2>
                <p className="mt-2 max-w-xs text-[15px] leading-relaxed text-[var(--color-body)]">{shot.instruction}</p>
              </>
            )}

            <div className="mt-6 w-full">
              <PhotoStage
                previewUrl={pendingPreviewUrl}
                status={status}
                rejection={rejection}
                reviewFailureCount={reviewFailureCount}
                onRetryReview={onRetryReview}
                onForceAccept={onForceAccept}
              />
            </div>
          </>
        )}
      </div>

      {/* Primary action — dominant, thumb-reachable, camera-first */}
      <div className="mx-auto w-full max-w-md">
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files)
            e.target.value = ''
          }}
        />
        <input
          ref={galleryInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files)
            e.target.value = ''
          }}
        />

        {status !== 'rejected' && status !== 'review_failed' && (
          <>
            <button
              type="button"
              disabled={busy || isPreparingPlan}
              onClick={() => cameraInputRef.current?.click()}
              className="flex w-full items-center justify-center gap-2 rounded-full bg-[var(--color-accent)] px-6 py-4 text-lg font-semibold text-white transition-colors hover:bg-[var(--color-accent-dark)] disabled:opacity-40"
            >
              <CameraIcon />
              Ta bild
            </button>
            <button
              type="button"
              disabled={busy || isPreparingPlan}
              onClick={() => galleryInputRef.current?.click()}
              className="mt-3 w-full text-center text-sm font-medium text-[var(--color-body)] underline underline-offset-4 disabled:opacity-40"
            >
              Välj bild istället
            </button>
          </>
        )}

        {status === 'rejected' && (
          <button
            type="button"
            onClick={() => cameraInputRef.current?.click()}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-[var(--color-accent)] px-6 py-4 text-lg font-semibold text-white transition-colors hover:bg-[var(--color-accent-dark)]"
          >
            <CameraIcon />
            Ta om bilden
          </button>
        )}

        {canSkip && status !== 'reviewing' && (
          <button
            type="button"
            onClick={onSkip}
            className="mt-2 w-full text-center text-xs font-normal text-[var(--color-body)]/50 transition-colors hover:text-[var(--color-body)]/80"
          >
            Hoppa över
          </button>
        )}

        {acceptedPreviews.length > 0 && (
          <div className="mt-6 flex gap-2 overflow-x-auto pb-1">
            {acceptedPreviews.map((url, i) => (
              <div key={url} className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-[var(--color-line)]">
                <img src={url} alt="" className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => onRemoveAccepted(i)}
                  aria-label="Ta bort bild"
                  className="absolute inset-0 flex items-center justify-center bg-black/50 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The seller's own photo, full-bleed, the instant it's picked. Everything
 * else (dim overlay, "Kontrollerar bilden…", checkmark, rejection feedback)
 * renders ON TOP of it — the photo itself never disappears behind a loading
 * state. Before any photo exists for this shot, shows a quiet framing guide
 * instead (nothing to display yet).
 */
function PhotoStage({
  previewUrl,
  status,
  rejection,
  reviewFailureCount,
  onRetryReview,
  onForceAccept,
}: {
  previewUrl: string | null
  status: CaptureStatus
  rejection: { reason: string | null; suggestion: string | null } | null
  reviewFailureCount: number
  onRetryReview: () => void
  onForceAccept: () => void
}) {
  if (!previewUrl) {
    return (
      <div className="relative mx-auto flex aspect-[4/5] w-full max-w-[280px] items-center justify-center rounded-3xl border-2 border-dashed border-[var(--color-line)] bg-[var(--color-cream-soft)]">
        <CornerBracket className="top-4 left-4" />
        <CornerBracket className="top-4 right-4 rotate-90" />
        <CornerBracket className="bottom-4 right-4 rotate-180" />
        <CornerBracket className="bottom-4 left-4 -rotate-90" />
        <PlaceholderSilhouette />
      </div>
    )
  }

  const dimmed = status === 'reviewing' || status === 'accepted' || status === 'rejected' || status === 'review_failed'

  return (
    <div className="relative mx-auto aspect-[4/5] w-full max-w-[280px] overflow-hidden rounded-3xl bg-[var(--color-cream-soft)]">
      <img src={previewUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />

      {dimmed && <div className="absolute inset-0 bg-[var(--color-ink)]/45" />}

      {status === 'reviewing' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white">
          <div className="pointer-events-none absolute inset-x-0 h-1/3 bg-gradient-to-b from-transparent via-white/30 to-transparent animate-scan-line" />
          <span className="text-sm font-semibold drop-shadow">Kontrollerar bilden…</span>
        </div>
      )}

      {status === 'accepted' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white animate-fade-up">
          <CheckCircleIcon />
          <span className="text-sm font-semibold drop-shadow">Bra bild</span>
        </div>
      )}

      {status === 'rejected' && rejection && (
        <div className="absolute inset-x-0 bottom-0 px-4 pb-4 pt-10 text-left">
          <div className="rounded-2xl bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
            <p className="text-sm font-semibold text-[var(--color-ink)]">{rejection.reason}</p>
            {rejection.suggestion && <p className="mt-0.5 text-sm text-[var(--color-body)]">{rejection.suggestion}</p>}
          </div>
        </div>
      )}

      {status === 'review_failed' && (
        <div className="absolute inset-x-0 bottom-0 px-4 pb-4 pt-10 text-left">
          <div className="rounded-2xl bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
            <p className="text-sm font-semibold text-[var(--color-ink)]">Vi kunde inte granska bilden just nu.</p>
            <p className="mt-0.5 text-sm text-[var(--color-body)]">Försök igen.</p>
            <button
              type="button"
              onClick={onRetryReview}
              className="mt-3 w-full rounded-full bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-black"
            >
              Försök igen
            </button>
            {reviewFailureCount >= 2 && (
              <button type="button" onClick={onForceAccept} className="mt-2 w-full text-center text-xs text-[var(--color-body)] underline underline-offset-4">
                Använd bilden ändå
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function CornerBracket({ className }: { className: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" className={`absolute text-[var(--color-body)]/40 ${className}`} aria-hidden>
      <path d="M1 9V3a2 2 0 0 1 2-2h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function PlaceholderSilhouette() {
  return (
    <svg width="72" height="72" viewBox="0 0 24 24" fill="none" className="text-[var(--color-body)]/25" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8.5" cy="8.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M21 15l-5.2-5.2a1.5 1.5 0 0 0-2.1 0L4 19.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CameraIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1-1.7A1 1 0 0 1 9.36 4.8h5.28a1 1 0 0 1 .86.5L16.5 7h2A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-9Z"
        stroke="white"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="3.2" stroke="white" strokeWidth="1.7" />
    </svg>
  )
}

function CheckCircleIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7.5 12.5l3 3 6-6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
