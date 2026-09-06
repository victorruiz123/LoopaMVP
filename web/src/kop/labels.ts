/**
 * Kategorinamnen, som köpsidan visar dem.
 *
 * Speglar server/src/butik/catalog.ts. Duplicerad med flit och med en smal yta: alternativet är ett
 * anrop till /api/butik/kategorier bara för att fylla en rullgardin i ett formulär som redan har
 * allt annat det behöver — och en tom rullgardin medan det anropet pågår.
 *
 * Slugen är kontraktet och den ändras inte; etiketten är text. Går de isär visar formuläret ett
 * gammalt namn på rätt kategori, vilket är ett litet fel. Ett anrop till hade gett en spinner mitt
 * i intaget, vilket är ett större.
 */
export const CATEGORY_LABELS: Record<string, string> = {
  "soffor": "Soffor",
  "fatoljer": "Fåtöljer",
  "bord": "Bord",
  "stolar": "Stolar",
  "forvaring": "Förvaring",
  "sangar": "Sängar",
  "skrivbord-kontor": "Skrivbord & kontor",
  "belysning": "Belysning",
  "ovrigt": "Övrigt",
};
