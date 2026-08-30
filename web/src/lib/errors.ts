import { t } from "./i18n";

/**
 * Rå fel från pipelinen -> något en säljare kan agera på.
 *
 * Analysvyn visade tidigare `job.error` ordagrant, vilket i praktiken betydde att en tillfällig
 * störning hos Gemini mötte säljaren som
 * `{"error":{"code":504,"message":"Deadline expired before operation could complete."}}` — ett
 * meddelande som varken säger vad som hände, om det var deras fel eller vad de ska göra nu.
 */
export interface FriendlyError {
  title: string;
  body: string;
  /** false när ett omtag omöjligt kan hjälpa — då är knappen bara ett löfte som bryts */
  retryable: boolean;
}

export function explainError(raw: string | null): FriendlyError {
  const text = (raw ?? "").toLowerCase();

  if (/api_key|unauthenticated|permission_denied|\b401\b|\b403\b/.test(text)) {
    return {
      title: t("Servern saknar en giltig nyckel"),
      body: t("Analysen kunde inte startas eftersom serverns API-nyckel saknas eller är ogiltig. Det behöver åtgärdas i serverns konfiguration."),
      retryable: false,
    };
  }
  if (/resource_exhausted|quota|\b429\b/.test(text)) {
    return {
      title: t("AI-kvoten är slut för stunden"),
      body: t("Dagens kvot för bildanalyser är förbrukad. Bildrutorna är sparade — försök igen senare."),
      retryable: true,
    };
  }
  // Överbelastning har en egen mening. Den möttes förut av "svarade inte i tid", vilket lät som att
  // väntan var för kort — säljaren trycker "försök igen" direkt och får samma svar. Det som hjälper
  // är att vänta en stund, och då ska det stå.
  if (/overloaded|överbelast/.test(text)) {
    return {
      title: t("AI-tjänsten är överbelastad"),
      body: t("Modellen har fler anrop än den hinner med just nu. Det är tillfälligt och beror inte på dina bilder — bildrutorna är sparade, så vänta en stund och försök igen."),
      retryable: true,
    };
  }
  if (/deadline|unavailable|aborted|timeout|\b50[0234]\b/.test(text)) {
    return {
      title: t("AI-tjänsten svarade inte i tid"),
      body: t("Det är en tillfällig störning och beror inte på dina bilder. Bildrutorna är sparade, så du behöver inte filma om."),
      retryable: true,
    };
  }
  if (/at least one image|no valid images/.test(text)) {
    return {
      title: t("Inga bilder kom fram"),
      body: t("Uppladdningen innehöll inga bilder som gick att läsa. Spela in eller ladda upp igen."),
      retryable: false,
    };
  }
  return {
    title: t("Analysen kunde inte slutföras"),
    body: t("Något gick fel på vägen. Bildrutorna är sparade, så ett nytt försök kostar dig inget mer än tiden."),
    retryable: true,
  };
}
