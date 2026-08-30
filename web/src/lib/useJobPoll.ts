import { useEffect, useState } from "react";
import { getJob } from "../api";
import type { ConditionJob } from "../types";

/**
 * Klientens egen bortre gräns.
 *
 * Servern kan dö mellan två pollningar — den lever i minnet, så en omstart tar varje pågående körning
 * med sig. Skärmen ska då sluta snurra och säga det, inte vänta för evigt på ett jobb ingen längre
 * arbetar med. Rundligare än serverns deadline, så serverns felmeddelande hinner fram först.
 */
const CLIENT_GIVE_UP_MS = 300_000;

export function useJobPoll(jobId: string, done: (job: ConditionJob) => boolean, intervalMs = 1200, restartKey = 0) {
  const [job, setJob] = useState<ConditionJob | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const until = Date.now() + CLIENT_GIVE_UP_MS;
    const poll = async () => {
      if (Date.now() > until) return setGaveUp(true);
      try {
        const j = await getJob(jobId);
        if (cancelled) return;
        setJob(j);
        // Ett fällt jobb är ett svar. Att fortsätta polla på det är att snurra på ett dött jobb.
        if (j.progress.stage === "error" || done(j)) return;
        setTimeout(poll, intervalMs);
      } catch {
        if (!cancelled) setTimeout(poll, 2000);
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, restartKey]);
  return { job, gaveUp, failed: job?.progress.stage === "error" };
}
