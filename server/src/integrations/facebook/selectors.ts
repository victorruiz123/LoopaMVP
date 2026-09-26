/**
 * Facebooks selektorer, samlade på ett ställe.
 *
 * Svenska etiketter först (kontot kör sv-SE), engelska som reserv. Det som är märkt VERIFIERAT är
 * avläst mot den riktiga ytan 2026-09-23 (grupp-sidor, sökningen, textinläggets skrivruta, Gå med-
 * knappen). Det som är märkt ANTAGET är byggt på Facebooks dokumenterade ytkonventioner och ska
 * bekräftas i en torrkörning mot den riktiga sidan innan det litas på — se rapporten i
 * docs/facebook.md för vad som är prövat.
 */

export const FB = {
  main: '[role="main"]',
  groupTitle: '[role="main"] h1',

  // ── Gruppsidan (VERIFIERAT) ─────────────────────────────────────────────
  /** Textinläggets skrivruta. Saknas i köp/sälj-grupper som bara har "Sälj något". */
  composerPost:
    '[role="button"]:has-text("Skriv något"), [role="button"]:has-text("Write something"), [role="button"]:has-text("Skapa ett offentligt inlägg"), [role="button"]:has-text("Create a public post")',
  /** Annonsformuläret i köp/sälj-grupper. Räknas inte som textinlägg — se membership.ts. */
  composerListing: '[role="button"]:has-text("Sälj något"), [role="button"]:has-text("Sell something")',
  feed: '[role="feed"]',
  /** Varje inlägg är ett direkt barn av flödet — inte role=article, som Facebook använder för kommentarer. */
  feedArticle: '[role="feed"] > div',
  feedAuthorLink: 'a[href*="/user/"]',
  postLink: 'a[href*="/posts/"], a[href*="/permalink/"]',

  // ── Skrivrutan (VERIFIERAT: redigeraren ligger i en omärkt dialog; "Skapa inlägg"-dialogen är ett tomt skal) ──
  composerEditor: '[role="dialog"] [contenteditable="true"][role="textbox"]',
  composerPhotoButton: '[role="dialog"] [role="button"][aria-label="Foto/video"], [role="dialog"] [role="button"][aria-label="Photo/video"]',
  composerFileInput: '[role="dialog"] input[type="file"][multiple], [role="dialog"] input[type="file"]',
  composerPublish: '[role="dialog"] [role="button"][aria-label="Publicera"], [role="dialog"] [role="button"][aria-label="Post"]',
  composerClose: '[role="dialog"] [aria-label="Stäng dialogrutan i skaparverktyget"], [role="dialog"] [aria-label="Close"], [role="dialog"] [aria-label="Stäng"]',
  discardConfirm: '[role="dialog"] [role="button"]:has-text("Ta bort"), [role="dialog"] [role="button"]:has-text("Discard"), [role="dialog"] [role="button"]:has-text("Kasta")',
  /** Länkförhandsvisningen som Facebook bygger när en adress skrivs i rutan. */
  composerLinkPreview: '[role="dialog"] a[href*="loopa"], [role="dialog"] [aria-label*="förhandsvisning" i], [role="dialog"] [aria-label*="preview" i]',
  mediaPreview: '[role="dialog"] img[src^="blob:"], [role="dialog"] [aria-label*="Ta bort"], [role="dialog"] [aria-label*="Remove"]',

  // ── Medlemskap (VERIFIERAT för knappen och "Har gått med"; dialogen ANTAGEN) ──
  joinButton:
    '[role="button"][aria-label="Gå med i grupp"], [role="button"][aria-label="Join group"], [role="button"]:has-text("Gå med i grupp"), [role="button"]:has-text("Join group")',
  memberIndicator: '[role="button"]:has-text("Har gått med"), [role="button"]:has-text("Joined"), [aria-label="Har gått med"], [aria-label="Joined"]',
  pendingIndicator:
    '[role="button"]:has-text("Avbryt begäran"), [role="button"]:has-text("Cancel request"), [role="button"]:has-text("Begäran skickad"), [role="button"]:has-text("Request sent")',
  membershipDialog: '[role="dialog"]:not(:has-text("Chattar")):not([aria-label="Messenger"])',
  /** Frågeelementen söks INUTI dialogen (dialog.locator) — därför utan [role="dialog"]-prefix. */
  questionRadioGroup: '[role="radiogroup"]',
  questionCheckbox: '[role="checkbox"]',
  questionTextbox: 'textarea, [contenteditable="true"][role="textbox"]',
  dialogSubmit:
    '[role="dialog"] [role="button"]:has-text("Skicka"), [role="dialog"] [role="button"]:has-text("Send"), [role="dialog"] [role="button"]:has-text("Nästa"), [role="dialog"] [role="button"]:has-text("Next"), [role="dialog"] [role="button"]:has-text("Gå med")',
  dialogClose: '[role="dialog"] [aria-label="Stäng"], [role="dialog"] [aria-label="Close"]',

  // ── Sökningen (VERIFIERAT) ──────────────────────────────────────────────
  searchGroupLinks: '[role="main"] a[href*="/groups/"]',

  // ── Marketplace (VERIFIERAT 2026-09-25 mot den riktiga ytan, svensk UI) ──
  marketplace: {
    createPath: "/marketplace/create/item",
    /** Rubrik och pris: textfält under en <label>. getByLabel(/^Titel$/) prövas först. */
    title: 'input[aria-label="Titel"], input[aria-label="Title"]',
    price: 'input[aria-label="Pris"], input[aria-label="Price"]',
    /** Plats är en kombinationsruta med förslag. */
    location: 'input[aria-label="Plats"][role="combobox"], input[aria-label="Plats"], input[aria-label="Location"]',
    /** Beskrivningen ligger under den hopfällda sektionen "Mer information" — se moreInfo. */
    description: 'textarea[aria-label="Beskrivning"], textarea[aria-label="Description"]',
    moreInfo: /Mer information|More details/,
    /** Kategori: en label med role=combobox som öppnar en DIALOG med en knapp per kategori. */
    category: '[role="main"] label[role="combobox"]:has-text("Kategori"), [role="main"] label[role="combobox"]:has-text("Category")',
    categoryOption: '[role="dialog"] [role="button"], [role="dialog"] button',
    /** Skick: en label med role=combobox och aria-haspopup=listbox; alternativen är role=option. */
    condition: '[role="main"] label[role="combobox"]:has-text("Skick"), [role="main"] label[role="combobox"]:has-text("Condition")',
    conditionOption: '[role="option"]',
    locationOption: '[role="listbox"] [role="option"], [role="option"]',
    fileInput: 'input[type="file"]',
    addPhotos: '[role="button"]:has-text("Lägg till foton"), [role="button"]:has-text("Add photos")',
    next: '[role="main"] [role="button"][aria-label="Nästa"], [role="main"] [role="button"][aria-label="Next"]',
    /**
     * BARA via aria-label (LÄRDOM 2026-09-26): en textmatchning på "Publicera" träffade förhandsgranskningens
     * "Publicerades för några sekunder sedan" på formulärets första sida och klickade i tomma intet.
     */
    publish: '[role="main"] [role="button"][aria-label="Publicera"], [role="main"] [role="button"][aria-label="Publish"]',
    leaveConfirm: '[role="dialog"] [role="button"]:has-text("Lämna"), [role="dialog"] [role="button"]:has-text("Leave"), [role="dialog"] [role="button"]:has-text("Kasta"), [role="dialog"] [role="button"]:has-text("Ta bort"), [role="dialog"] [role="button"]:has-text("Discard")',
    fieldError: '[aria-invalid="true"], [role="alert"]',
  },

  /** En dialog som inte är Messenger-panelen — den ligger alltid på sidan och får aldrig stängas eller läsas som vår. */
  dialog: '[role="dialog"]:not([aria-label="Messenger"]):not([aria-label="Chattar"]):not([aria-label="Chats"])',

  // ── Säljinlägget i en grupp (VERIFIERAT 2026-09-26 mot den riktiga ytan, svensk UI) ──
  // "Sälj något" öppnar dialogen "Skapa nytt säljinlägg" med typvalet "Vara till salu". Formuläret är
  // Marketplace-formuläret i en dialog: filfält, Titel, Pris, Skick (combobox + role=option),
  // "Mer information" med Beskrivning, Produkttaggar, Plats och träffalternativ. Nästa ger steget
  // "Dela på fler platser": en kryssruta per grupp (målgruppen förvald), en Marketplace-rad och Publicera.
  groupListing: {
    typeItem: '[role="button"]:has-text("Vara till salu"), [role="button"]:has-text("Item for sale")',
    fileInput: 'input[type="file"]',
    removePhoto: '[role="button"][aria-label^="Ta bort foto"], [role="button"][aria-label^="Remove photo"]',
    title: 'input[aria-label="Titel"], input[aria-label="Title"]',
    price: 'input[aria-label="Pris"], input[aria-label="Price"]',
    condition: 'label[role="combobox"]:has-text("Skick"), label[role="combobox"]:has-text("Condition")',
    conditionOption: '[role="option"]',
    moreInfo: '[role="button"]:has-text("Mer information"), [role="button"]:has-text("More details")',
    description: 'textarea[aria-label="Beskrivning"], textarea[aria-label="Description"]',
    location: 'input[aria-label="Plats"], input[aria-label="Location"]',
    locationOption: '[role="listbox"] [role="option"], [role="option"]',
    next: '[role="button"][aria-label="Nästa"], [role="button"][aria-label="Next"]',
    publish: '[role="button"][aria-label="Publicera"], [role="button"][aria-label="Publish"], [role="button"][aria-label="Post"]',
    /** Raderna i "Dela på fler platser": en kryssruta per grupp med namn och medlemsantal. */
    audienceGroupCheckbox: '[role="checkbox"]',
    marketplaceRow: '[role="button"]:has-text("Varor på Marketplace"), [role="button"]:has-text("Items on Marketplace"), [role="switch"]:has-text("Marketplace"), [role="checkbox"]:has-text("Marketplace")',
    /** Syns i dialogen bara när Marketplace är påslaget (Marketplace-alternativen). */
    marketplaceSwitch: '[role="switch"]',
    close: '[role="dialog"] [aria-label="Stäng"], [role="dialog"] [aria-label="Close"]',
    itemLink: 'a[href*="/marketplace/item/"]',
    /** Säljinläggets kort i gruppflödet länkar hit (VERIFIERAT 2026-09-26), inte till /posts/. */
    commerceLink: 'a[href*="/commerce/listing/"]',
  },
} as const;

/** Texter på gruppsidan som säger var medlemskapet står. */
export const TEXT = {
  // Ingen ordgräns EFTER frasen: knapparna kan ligga sida vid sida i innerText ("Har gått medDela"),
  // och frasen "Har gått med" förekommer inte som del av något annat ord.
  member: /Har gått med|\bJoined\b/,
  notMember: /Gå med i grupp|\bJoin group\b/,
  pending: /Avbryt begäran|Cancel request|Begäran skickad|Request sent|väntar på godkännande|pending approval|awaiting (admin )?approval|din begäran (har|är) skickats|your request (has been|was) sent/i,
  postPendingApproval: /väntar på godkännande|pending approval|pending review|granskas av en administratör|admin(s)? will review|kommer att granskas/i,
  joinBlocked: /du kan (för tillfället )?inte gå med|you can'?t join this group|gruppen tillåter inte nya medlemmar|this group is not accepting new members|inte tillgänglig för nya medlemmar/i,
  notAvailable: /innehållet är inte tillgängligt|content isn'?t available|this content isn'?t available right now|sidan hittades inte|page not found/i,
  publicGroup: /offentlig grupp|public group/i,
  privateGroup: /privat grupp|private group/i,
  // Säljinlägget (VERIFIERAT 2026-09-26).
  listingTypeChooser: /Välj typ av säljinlägg|Choose (a )?listing type/i,
  photoAttached: /\d+\s+foton?\s+bifogad|\d+\s+photos?\s+attached/i,
  shareMorePlaces: /Dela på fler platser|Share to more places|List in more places/i,
  /** Raden för en grupp i Dela på fler platser slutar med medlemsantalet och synligheten. */
  memberCountRow: /\d[\d\s,.]*\s*(tn\s+)?(medlemmar|members)/i,
} as const;
