/**
 * En HÅRD tidsgräns för hela identifieringen — inte en tidsgräns per anrop.
 *
 * BAKGRUNDEN. Identifieringen hade tre olika klockor: 80 s för anropet, 56 s för första försöket, 50 s för eskaleringen, och ett
 * omförsök som startade EFTER att det första fallit. De lades ovanpå varandra: en körning kunde ta 74–80 s, ett svar kunde komma
 * efter att säljaren gett upp, och ett avbrutet anrop kunde fortsätta kosta pengar efter att resultatet var skrivet. Kravet är
 * att identifieringen har ETT tak som aldrig överskrids, och det kräver EN klocka som alla delar. Taket var 60 s tills det togs bort 2026-10-24
 * (se pipeline/identifieringsval.ts); standardvärdet är nu 180 s (IDENTIFY_DEADLINE_MS i research/config.ts, LOOPA_IDENTIFY_DEADLINE_MS).
 *
 * VAD KLOCKAN GÖR.
 *  - `remaining()` är tiden kvar för ALLT — modellanrop, sökning, verktyg och efterbehandling — räknad från att identifieringen startade.
 *  - `signal` avbryts när tiden är slut. Skickas den till varje anrop stängs strömmarna samtidigt, och inget fortsätter i bakgrunden.
 *  - `canStart(minMs)` svarar på "hinner det här bli klart?" INNAN arbetet startas. Ett anrop som inte kan hinna startas inte.
 *  - `budget(reserveMs)` är det ett anrop får av tiden när något ska hända EFTER det (tolkning, skrivning till jobbet).
 *
 * Klockan har en liten marginal inbyggd av den som skapar den (se IDENTIFY_DEADLINE_MS): taket är det säljaren ser, och
 * leveransen till skärmen (pollning, rendering) ligger utanför servern.
 */

export class Deadline {
  readonly startedAt: number;
  readonly totalMs: number;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null;
  private readonly now: () => number;

  constructor(totalMs: number, opts: { startedAt?: number; now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    this.startedAt = opts.startedAt ?? this.now();
    this.totalMs = totalMs;
    const left = this.remaining();
    if (left <= 0) {
      this.timer = null;
      this.controller.abort(new DeadlineExceeded());
    } else {
      this.timer = setTimeout(() => this.controller.abort(new DeadlineExceeded()), left);
      // En klocka som ingen väntar på ska inte hålla processen vid liv.
      this.timer.unref?.();
    }
  }

  /** Millisekunder kvar, aldrig under noll. */
  remaining(): number {
    return Math.max(0, this.startedAt + this.totalMs - this.now());
  }

  elapsed(): number {
    return this.now() - this.startedAt;
  }

  expired(): boolean {
    return this.remaining() <= 0;
  }

  /** Avbryts när tiden är slut. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Hinner arbete som kräver minst `minMs` bli klart? */
  canStart(minMs: number): boolean {
    return this.remaining() >= minMs;
  }

  /** Det ett anrop får när `reserveMs` måste finnas kvar efter det. Aldrig negativt. */
  budget(reserveMs = 0): number {
    return Math.max(0, this.remaining() - reserveMs);
  }

  /** En signal som avbryts av tidsgränsen ELLER av någon av de andra. */
  within(...others: Array<AbortSignal | undefined>): AbortSignal {
    return AbortSignal.any([this.controller.signal, ...others.filter((s): s is AbortSignal => !!s)]);
  }

  /** Stoppar klockan. Anropas när identifieringen är klar, så att timern inte avbryter något som redan är färdigt. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Anledningen på en avbruten signal: tiden tog slut (och inte att anroparen avbröt). */
export class DeadlineExceeded extends Error {
  constructor() {
    super("identifieringens tidsgräns nåddes");
    this.name = "DeadlineExceeded";
  }
}

export const isDeadlineExceeded = (reason: unknown): boolean => reason instanceof DeadlineExceeded || (reason instanceof Error && reason.name === "DeadlineExceeded");
