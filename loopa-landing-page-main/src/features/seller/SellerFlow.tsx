import { useEffect, useState } from 'react'
import { filesToUploadedImages } from '../generator/generateListingClient'
import { generateSellerListing, SellerGenerateError, type SellerGenerateOutcome } from './sellerGenerateClient'
import type { GeneratedListingResult, UploadedImage } from '../generator/schema'
import { createReviewThumbnail, reviewPhoto, ReviewPhotoError } from './reviewPhotoClient'
import { fetchShotPlan, ShotPlanError } from './shotPlanClient'
import { FRONTAL_SHOT } from './fixedShots'
import { marketplaceListingFromGeneratedListing } from './engines'
import { FIXTURE_CANDIDATES, FIXTURE_REVIEW_ACCEPTED, FIXTURE_REVIEW_REJECTED, FIXTURE_RESULT_CONFIDENT, FIXTURE_SHOT_PLAN } from './fixtures'
import type { AcceptedPhoto, ImageReviewResult, SellerProductCandidate, SellerResolution, SellerSessionState, ShotPlan } from './types'
import { StartScreen } from './screens/StartScreen'
import { BrandScreen } from './screens/BrandScreen'
import { CaptureScreen, type CaptureStatus } from './screens/CaptureScreen'
import { AnalyzingScreen } from './screens/AnalyzingScreen'
import { ModelSelectScreen } from './screens/ModelSelectScreen'
import { ResultScreen } from './screens/ResultScreen'
import { CompleteScreen } from './screens/CompleteScreen'

/**
 * Dev-only deterministic mode (?mock=1 or ?mock=2, only ever active under
 * `vite dev`) — lets every screen/state be visually verified without spending
 * a single real Gemini call. ?mock=2 additionally makes the first generation
 * request return three candidates, so the ModelSelectScreen (ambiguity →
 * seller chooses) is deterministically reachable. Never reachable in a
 * production build: import.meta.env.DEV is statically false there and this
 * whole branch is dead-code-eliminated. This is the ONLY place a fake AI
 * result may ever come from — every other code path in this file either uses
 * the real endpoint or surfaces a real failure state. No production/preview
 * runtime path silently substitutes a fake result for a failed real call.
 */
const MOCK_PARAM = import.meta.env.DEV && typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('mock') : null
const MOCK_MODE = MOCK_PARAM === '1' || MOCK_PARAM === '2'
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
let mockShotCount = 0
async function mockReviewPhoto(): Promise<ImageReviewResult> {
  await wait(150)
  mockShotCount += 1
  // Reject the very first attempt once, purely so the rejection UI is easy to see in mock mode.
  if (mockShotCount === 1) return FIXTURE_REVIEW_REJECTED
  return FIXTURE_REVIEW_ACCEPTED
}
async function mockShotPlan(): Promise<ShotPlan> {
  await wait(600)
  return FIXTURE_SHOT_PLAN
}
async function mockGenerateListing(resolution: SellerResolution | null): Promise<SellerGenerateOutcome> {
  await wait(1500)
  if (MOCK_PARAM === '2' && !resolution) return { kind: 'needs_selection', candidates: FIXTURE_CANDIDATES }
  return { kind: 'result', result: FIXTURE_RESULT_CONFIDENT }
}

/** Accept transition is deliberately short — a satisfying beat, not a pause. See CaptureScreen for the visual treatment. */
const ACCEPT_TRANSITION_MS = 450

export function SellerFlow() {
  const [state, setState] = useState<SellerSessionState>('draft')
  const [brand, setBrand] = useState('')
  const [sellerNote, setSellerNote] = useState('')

  const [shots, setShots] = useState<ShotPlan['additionalShots']>([FRONTAL_SHOT])
  const [shotIndex, setShotIndex] = useState(0)
  const [accepted, setAccepted] = useState<AcceptedPhoto[]>([])
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>('idle')
  const [rejection, setRejection] = useState<{ reason: string | null; suggestion: string | null } | null>(null)
  const [reviewFailureCount, setReviewFailureCount] = useState(0)
  const [isPreparingPlan, setIsPreparingPlan] = useState(false)
  const [planFailed, setPlanFailed] = useState(false)
  /** Rough product type the shot-plan step already inferred (e.g. "soffa"). Only used to make a last-resort emergency listing less generic — never shown as a verified claim. */
  const [productHint, setProductHint] = useState<string | null>(null)

  // The current photo's local preview appears the instant it's selected —
  // well before any network round trip — and stays on screen through
  // reviewing/rejected/review_failed/accepted. Never wait for the server to
  // show the seller their own photo.
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState<string | null>(null)

  const [result, setResult] = useState<GeneratedListingResult | null>(null)
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  /** Bumped by retryAnalysis() to force the analysis effect to re-run even though `state` itself doesn't change (we stay in 'analyzing' across a retry). */
  const [analysisAttempt, setAnalysisAttempt] = useState(0)
  /** Candidates from an ambiguous identification — drives the ModelSelectScreen. */
  const [candidates, setCandidates] = useState<SellerProductCandidate[]>([])
  /** How the seller resolved the product identity. Set by the ModelSelectScreen, sent with the follow-up generation request. Null on the first request. */
  const [resolution, setResolution] = useState<SellerResolution | null>(null)

  const heroImageUrl = accepted[0]?.previewUrl ?? null

  function handleFileSelected(file: File) {
    // Instant local preview — created synchronously, before any async work,
    // so the photo is on screen before the review request has even been built.
    if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl)
    const previewUrl = URL.createObjectURL(file)
    setPendingFile(file)
    setPendingPreviewUrl(previewUrl)
    setCaptureStatus('reviewing')
    setRejection(null)
    void runReview(file, previewUrl)
  }

  async function runReview(file: File, previewUrl: string) {
    const shot = shots[shotIndex]
    try {
      // A small, review-only derivative — NOT the file that ends up stored.
      // Keeps the review request tiny and fast; the seller's original photo
      // is untouched and only compressed to full listing quality on accept.
      const thumbnail = MOCK_MODE ? null : await createReviewThumbnail(file)
      const review: ImageReviewResult = MOCK_MODE
        ? await mockReviewPhoto()
        : await reviewPhoto({ image: thumbnail!, shotTitle: shot.title, shotInstruction: shot.instruction })
      if (review.accepted) {
        setCaptureStatus('accepted')
        setTimeout(() => void acceptCurrentShot(file, previewUrl, review), ACCEPT_TRANSITION_MS)
      } else {
        setCaptureStatus('rejected')
        setRejection({ reason: review.reason, suggestion: review.suggestion })
      }
    } catch (err) {
      // NO FAIL-OPEN: a network/AI failure is a genuine, distinct state —
      // never a silent accept. The photo stays visible (pendingFile/
      // pendingPreviewUrl) so retry re-reviews it instead of asking for a retake.
      console.error('[SellerFlow] review-photo call failed:', err instanceof ReviewPhotoError ? err.message : err)
      setCaptureStatus('review_failed')
      setReviewFailureCount((n) => n + 1)
    }
  }

  function retryReview() {
    if (!pendingFile || !pendingPreviewUrl) return
    void runReview(pendingFile, pendingPreviewUrl)
  }

  /** Escape hatch after repeated AI-review failures: accept the pending photo without a successful review. Never available on the first failure. */
  function forceAccept() {
    if (!pendingFile || !pendingPreviewUrl) return
    void acceptCurrentShot(pendingFile, pendingPreviewUrl)
  }

  async function acceptCurrentShot(file: File, previewUrl: string, review?: ImageReviewResult) {
    // Full listing-quality compression happens ONLY now, for an accepted
    // photo — never wasted on photos that get rejected or retaken.
    const { images } = await filesToUploadedImages([file])
    const uploadedImage: UploadedImage = images[0] ?? { mimeType: file.type || 'image/jpeg', dataBase64: '' }

    const shot = shots[shotIndex]
    const photo: AcceptedPhoto = {
      previewUrl,
      shotTitle: shot.title,
      uploadedImage,
      review: review ?? { accepted: true, reason: null, suggestion: null },
    }
    setAccepted((prev) => [...prev, photo])
    resetPendingCapture()

    const isFrontal = shotIndex === 0
    if (isFrontal && shots.length === 1) {
      // A small review-style derivative for the shot-plan call too — it only
      // needs to recognize the rough product type, not full resolution.
      const planImage = MOCK_MODE ? uploadedImage : await createReviewThumbnail(file)
      requestShotPlan(planImage)
      return
    }

    advanceOrFinish()
  }

  /** Available on every shot AFTER the frontal one — the frontal photo always stays required. Advances immediately, no confirmation, no dead end: reaching the end of the plan via skips finishes the flow exactly like reaching it via accepts. */
  function skipCurrentShot() {
    if (shotIndex === 0) return
    resetPendingCapture()
    advanceOrFinish()
  }

  function resetPendingCapture() {
    setCaptureStatus('idle')
    setRejection(null)
    setPendingFile(null)
    setPendingPreviewUrl(null)
    setReviewFailureCount(0)
  }

  /** Shared by accept and skip — reaching the end of the shot list always moves on to analysis, regardless of how many shots were actually accepted vs. skipped. Never traps the seller. */
  function advanceOrFinish() {
    const nextIndex = shotIndex + 1
    if (nextIndex >= shots.length) {
      setState('analyzing')
    } else {
      setShotIndex(nextIndex)
    }
  }

  function requestShotPlan(frontalImage: UploadedImage) {
    setIsPreparingPlan(true)
    setPlanFailed(false)
    ;(MOCK_MODE ? mockShotPlan() : fetchShotPlan({ image: frontalImage, brand, sellerNote }))
      .then((plan) => {
        setShots([FRONTAL_SHOT, ...plan.additionalShots])
        setShotIndex(1)
        if (plan.productHint) setProductHint(plan.productHint)
      })
      .catch((err) => {
        // NO FAIL-OPEN: a failed shot-plan call must never be silently
        // replaced by a generic plan — show a real retry state instead.
        console.error('[SellerFlow] shot-plan call failed:', err instanceof ShotPlanError ? err.message : err)
        setPlanFailed(true)
      })
      .finally(() => setIsPreparingPlan(false))
  }

  function retryShotPlan() {
    const frontal = accepted[0]
    if (!frontal) return
    requestShotPlan(frontal.uploadedImage)
  }

  function handleRemoveAccepted(index: number) {
    setAccepted((prev) => {
      prev.slice(index).forEach((p) => URL.revokeObjectURL(p.previewUrl))
      return prev.slice(0, index)
    })
    setShotIndex(index)
    if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl)
    resetPendingCapture()
  }

  useEffect(() => {
    if (state !== 'analyzing' || result) return
    let cancelled = false
    setAnalysisError(null)
    // /api/seller/generate always answers 200 for a valid submission: either
    // the best result it could assemble (full → partial → fallback) or a
    // candidate-selection pause the seller resolves. This catch is reserved
    // for a genuine transport failure — the request never reaching Loopa at
    // all. A degraded AI result is NOT an error and never lands here.
    ;(MOCK_MODE
      ? mockGenerateListing(resolution)
      : generateSellerListing({
          brand,
          sellerNote: sellerNote || undefined,
          productHint,
          images: accepted.map((p) => p.uploadedImage),
          resolution,
        })
    )
      .then((outcome) => {
        if (cancelled) return
        if (outcome.kind === 'needs_selection') {
          setCandidates(outcome.candidates)
          setState('selecting_model')
        } else {
          setResult(outcome.result)
          setState('review')
        }
      })
      .catch((err) => {
        if (cancelled) return
        setAnalysisError(err instanceof SellerGenerateError ? err.message : 'Något gick fel. Försök igen.')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, analysisAttempt])

  function retryAnalysis() {
    setAnalysisError(null)
    setResult(null)
    setAnalysisAttempt((n) => n + 1)
  }

  /** The seller resolved the product identity (picked a candidate, typed a model, or continued without one) — resume generation with that resolution attached. */
  function resolveProduct(r: SellerResolution) {
    setResolution(r)
    setState('analyzing')
  }

  function handleApprove(final: { title: string; description: string }) {
    setIsSubmitting(true)
    setResult((prev) => (prev ? { ...prev, listing: { ...prev.listing, title: final.title, description: final.description } } : prev))
    setState('ready_for_marketplace')
    setIsSubmitting(false)
  }

  if (state === 'draft') return <StartScreen onStart={() => setState('brand_entered')} />

  if (state === 'brand_entered') {
    return (
      <BrandScreen
        brand={brand}
        onBrandChange={setBrand}
        sellerNote={sellerNote}
        onSellerNoteChange={setSellerNote}
        onContinue={() => setState('capturing')}
      />
    )
  }

  if (state === 'capturing') {
    if (planFailed) {
      return (
        <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col items-center justify-center gap-4 px-6 text-center sm:min-h-[calc(100dvh-4rem)]">
          <p className="max-w-xs text-[15px] text-[var(--color-body)]">Vi kunde inte anpassa guiden just nu. Försök igen.</p>
          <button
            type="button"
            onClick={retryShotPlan}
            className="inline-flex items-center justify-center rounded-full bg-[var(--color-accent)] px-6 py-3 text-[15px] font-medium text-white hover:bg-[var(--color-accent-dark)]"
          >
            Försök igen
          </button>
        </div>
      )
    }
    return (
      <CaptureScreen
        shot={shots[shotIndex]}
        shotNumber={shotIndex + 1}
        totalShots={shots.length}
        status={captureStatus}
        pendingPreviewUrl={pendingPreviewUrl}
        rejection={rejection}
        reviewFailureCount={reviewFailureCount}
        isPreparingPlan={isPreparingPlan}
        acceptedPreviews={accepted.map((p) => p.previewUrl)}
        canSkip={shotIndex > 0}
        onFileSelected={handleFileSelected}
        onRemoveAccepted={handleRemoveAccepted}
        onRetryReview={retryReview}
        onForceAccept={forceAccept}
        onSkip={skipCurrentShot}
      />
    )
  }

  if (state === 'analyzing') {
    if (analysisError) {
      return (
        <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col items-center justify-center gap-4 px-6 text-center sm:min-h-[calc(100dvh-4rem)]">
          <p className="max-w-xs text-[15px] text-[var(--color-body)]">{analysisError}</p>
          <button
            type="button"
            onClick={retryAnalysis}
            className="inline-flex items-center justify-center rounded-full bg-[var(--color-accent)] px-6 py-3 text-[15px] font-medium text-white hover:bg-[var(--color-accent-dark)]"
          >
            Försök igen
          </button>
        </div>
      )
    }
    return <AnalyzingScreen heroImageUrl={heroImageUrl} />
  }

  if (state === 'selecting_model') {
    return (
      <ModelSelectScreen
        brand={brand}
        candidates={candidates}
        onSelect={(c) => resolveProduct({ kind: 'seller_selected', selected: c })}
        onManual={(model) => resolveProduct({ kind: 'manual', manualModel: model })}
        onUnknown={() => resolveProduct({ kind: 'unknown' })}
      />
    )
  }

  if (state === 'review' && result) {
    return <ResultScreen result={result} heroImageUrl={heroImageUrl} onApprove={handleApprove} isSubmitting={isSubmitting} />
  }

  if (state === 'ready_for_marketplace' && result) {
    const listing = marketplaceListingFromGeneratedListing(
      result,
      accepted.map((p) => p.previewUrl),
    )
    return <CompleteScreen heroImageUrl={heroImageUrl} listing={listing} />
  }

  return null
}
