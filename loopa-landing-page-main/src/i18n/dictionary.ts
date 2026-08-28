export interface Dictionary {
  nav: {
    home: string
    about: string
    brands: string
    secondhand: string
    contact: string
  }
  hero: {
    titleLine1: string
    titleLine2: string
    subtitle: string
    categoryLine: string
    ctaPrimary: string
    ctaSecondary: string
    stages: string[]
    readyBadge: string
  }
  howItWorks: {
    heading: string
    steps: { num: string; title: string; desc: string }[]
    identifyTags: string[]
  }
  generate: {
    heading: string
    subheading: string
    fashionGateLabel: string
    furnitureGateLabel: string
    generateButton: string
    generating: string
    fashionResultLabel: string
  }
  generatorPreview: {
    conditionLabel: string
    priceLabel: string
    creditLabel: string
    rangeLabel: string
    descriptionLabel: string
  }
  listingDemo: {
    sellerPhotos: string
    loopaListing: string
    published: string
    productTitle: string
    productSubtitle: string
    brandLabel: string
    brandValue: string
    modelLabel: string
    modelValue: string
    configLabel: string
    configValue: string
    dimensionsLabel: string
    dimensionsValue: string
    materialLabel: string
    materialValue: string
    colorLabel: string
    colorValue: string
    conditionLabel: string
    conditionValue: string
    estValueLabel: string
    estValueValue: string
    descriptionLabel: string
    description: string
    askButton: string
    priceLabel: string
    priceValue: string
    priceNote: string
    buyNow: string
  }
  chat: {
    title: string
    subtitle: string
    placeholder: string
    send: string
    close: string
    localDemoBadge: string
    thinking: string
    suggested: string[]
    greeting: string
  }
  buyFlow: {
    summaryTitle: string
    summaryItemLabel: string
    summaryPriceLabel: string
    summaryContinue: string
    summaryDisclaimer: string
    deliveryHeading: string
    deliveryHelper: string
    deliveryCounter: (n: number) => string
    deliverySend: string
    waitingHeading: string
    waitingSub: string
    confirmedHeading: string
    confirmedSub: string
    confirmedContinue: string
    trackerHeading: string
    trackerDisclaimer: string
    trackerStages: string[]
    doneHeading: string
    doneSub: string
    doneButton: string
    close: string
    back: string
  }
  brands: {
    heading: string
    body: string
    keepsHeading: string
    keeps: string[]
    automatesHeading: string
    automates: string[]
    cta: string
    pilotCta: string
    exampleLabel: string
    poweredBy: string
    tabFashion: string
    tabFurniture: string
  }
  brandExperience: {
    heading: string
    fashionSubtext: string
    furnitureSubtext: string
  }
  brandsDemo: {
    heading: string
    body: string
    stageLabels: string[]
    resetLabel: string
    sell: {
      brandName: string
      itemName: string
      newLabel: string
      newPrice: string
      sellBackButton: string
      twoPhotosNote: string
      garmentPhotoLabel: string
      labelPhotoLabel: string
      continueButton: string
    }
    ai: {
      heading: string
      colorLabel: string
      color: string
      sizeLabel: string
      size: string
      materialLabel: string
      material: string
      conditionLabel: string
      conditionValue: string
      eligibleLabel: string
      recommendedPriceLabel: string
      recommendedPrice: string
      offerHeading: string
      offerCash: string
      offerCredit: string
      continueButton: string
    }
    approve: {
      heading: string
      automationNote: string
      customerLabel: string
      customerValue: string
      productLabel: string
      conditionLabel: string
      suggestedPriceLabel: string
      suggestedCreditLabel: string
      approveButton: string
      rejectButton: string
      approvedNote: string
      inventoryNote: string
      rejectedNote: string
      tryAgainButton: string
    }
    resell: {
      brandPageLabel: string
      preLovedLabel: string
      preLovedPrice: string
      available: string
      secondhandUrl: string
      productCardName: string
      conditionLabel: string
      conditionValue: string
      brandOwnsChip: string
      loopaPowersChip: string
    }
  }
  storefront: {
    searchPlaceholder: string
    account: string
    cart: string
    categories: string[]
    kicker: string
    heading: string
    body: string
    sellCta: string
    browseCta: string
    valuateTitle: string
    valuateSteps: string[]
    estimatedLabel: string
    creditLabel: string
    bonusNote: string
    pickupNote: string
    nearYou: string
    listingsCount: string
    viewListing: string
  }
  furnitureProof: {
    heading: string
    body: string
    identifiedHeading: string
    brandLabel: string
    brand: string
    modelLabel: string
    model: string
  }
  brandValue: {
    heading: string
    pillars: {
      title: string
      tagline: string
      items: { h: string; b: string }[]
    }[]
  }
  technology: {
    heading: string
    body: string
    layer1Label: string
    layer1Items: string[]
    layer2Label: string
    layer2Items: string[]
    currentLabel: string
    futureLabel: string
    current: string[]
    future: string[]
  }
  about: {
    heading: string
    body: string
    badge1: string
    badge2: string
    originNote: string
  }
  team: {
    heading: string
    members: { name: string; role: string; bio: string }[]
  }
  advisors: {
    heading: string
    body: string
  }
  contact: {
    heading: string
    body: string
    cta: string
    generalNote: string
    form: {
      name: string
      company: string
      email: string
      message: string
      submit: string
      submitting: string
      success: string
      errorRequired: string
      errorEmail: string
    }
  }
  footer: {
    tagline: string
    location: string
  }
  common: {
    stockholm: string
    linkedin: string
    currency: string
    illustrativeDemo: string
    or: string
  }
  brandsPage: {
    hero: {
      eyebrow: string
      titleLine1: string
      titleLine2: string
      subtitle: string
      ctaPrimary: string
      ctaSecondary: string
      /** Caption suffix after the demo product's own "Brand · Name" (e.g. "exempelprodukt"). */
      exampleSuffix: string
    }
    valueWall: {
      heading1: string
      heading2: string
      stats: { value: string; title: string; body: string }[]
      sourceNote: string
    }
    preview: {
      eyebrow: string
      heading: string
      subheading: string
      urlSrLabel: string
      placeholder: string
      submitIdle: string
      submitLoading: string
      tryLabel: string
      statusPartial: (count: number, min: number) => string
      statusEmpty: (domain: string) => string
      loadingSteps: string[]
      successHeading: (company: string | null) => string
      successBadge: (count: number) => string
      idleNote: string
      honesty: string
      ctaLead: string
      ctaButton: string
      conditionExample: string
      estimateLabel: string
      integrationHeading: string
      integrationBody: string
    }
    productPageMock: {
      ny: string
      secondhandAlternativ: string
      fromLabel: (price: string) => string
      availableNote: (grade: string) => string
      ctaSeeSecondhand: string
      priceUnknown: string
    }
    ownIt: {
      heading1: string
      heading2: string
      todayLabel: string
      todaySteps: string[]
      todayBody: string
      withLoopaLabel: string
      withLoopaSteps: string[]
      withLoopaBody: string
    }
    hardPart: {
      heading: string
      subheading: string
      sellerLine: string
      pipeline: string[]
      aiAssessed: string
      conditionPrefix: string
      trustLine: string
      exampleNote: string
    }
    models: {
      eyebrow: string
      heading: string
      subheading: string
      flexNote: string
      closing: string
    }
    finalCta: {
      heading1: string
      heading2: string
      body: string
      ctaTalk: string
    }
  }
  secondhandPage: {
    hero: {
      eyebrow: string
      titleLine1: string
      titleAccent: string
      subtitle: string
      subtitle2: string
      ctaPrimary: string
      ctaSecondary: string
    }
    why: {
      heading: string
      values: { title: string; body: string }[]
    }
    generator: {
      stepOf: (n: number, total: number) => string
      mode: {
        stepLabel: string
        heading: string
        continueButton: string
      }
      input: {
        stepLabel: (categoryLabel: string) => string
        heading: string
        changeCategory: string
        brandLabel: string
        brandPlaceholder: string
        modelLabel: string
        modelPlaceholder: string
        fashionFieldsHelper: string
        fashionBrandLabel: string
        fashionBrandPlaceholder: string
        styleCodeLabel: string
        styleCodePlaceholder: string
        sizeLabel: string
        sizePlaceholder: string
        productHeadline: string
        productHelper: string
        labelHeadline: string
        labelBadge: string
        labelHelper: string
        labelExamples: Record<'furniture' | 'fashion', string>
        productDropHint: (min: number, max: number) => string
        labelDropHint: (max: number) => string
        clickToUpload: string
        minRequired: (min: number) => string
        removeImage: string
        addMore: string
        continueButton: string
      }
      website: {
        stepLabel: string
        heading: string
        changeImages: string
        urlLabel: string
        urlPlaceholder: string
        urlHelper: string
        errorPersistHint: string
        retryButton: string
        generateButton: string
      }
      loading: {
        steps: Record<'furniture' | 'fashion', string[]>
        note: string
        stillWorkingNote: string
      }
      errors: {
        imagesUnreadable: string
        genericFailed: string
        unexpectedServer: (status: number) => string
        genericFailedWithStatus: (status: number) => string
        imagesExcludedNote: (count: number) => string
      }
      result: {
        stepLabel: string
        resetButton: string
        adaptedFor: (domain: string) => string
        observeLabel: string
        defaultCategory: string
        specifications: string
        noSpecifications: string
        condition: string
        aiAssessed: string
        notAssessed: string
        uncertainAssessment: string
        aiDisclaimer: string
        identityUncertainLabel: string
        verifiedSourceBadge: string
        price: string
        insufficientPricingData: string
        retailPriceLabel: string
        conditionText: string
        seoReady: string
        seoReadyBadge: string
        adaptedForWebshop: (domain: string) => string
        seoTitleLabel: string
        metaTitleLabel: string
        metaDescriptionLabel: string
        urlLabel: string
        imageAltLabel: string
        structuredAttributesLabel: string
        jsonLdSummary: string
        structureNote: string
        readyToPublish: string
        workflowSteps: string[]
        integrationNote: string
        publishButton: string
        sourcesLabel: string
        editableHint: string
        attributeSourceAria: (label: string) => string
      }
      publishModal: {
        heading: string
        body1: string
        body2: string
        integrationNote: string
        ctaTalk: string
        ctaBack: string
      }
    }
  }
}

const sv: Dictionary = {
  nav: {
    home: 'Hem',
    about: 'Om oss',
    brands: 'För varumärken',
    secondhand: 'För secondhandaktörer',
    contact: 'Kontakta oss',
  },
  hero: {
    titleLine1: 'Automatiserad mjukvara',
    titleLine2: 'för second hand.',
    subtitle:
      'Loopa automatiserar arbetet från produkt till återförsäljning: identifiering, produktdata, skick, prissättning och försäljning.',
    categoryLine: 'För mode, möbler och fler produktkategorier.',
    ctaPrimary: 'Se hur det funkar',
    ctaSecondary: 'För varumärken',
    stages: ['Foto', 'Identifiera', 'Data', 'Skick', 'Värde', 'Redo'],
    readyBadge: 'Redo för återförsäljning',
  },
  howItWorks: {
    heading: 'Från produkt till återförsäljning.',
    steps: [
      { num: '01', title: 'Fånga produkten', desc: 'Ladda upp foton av produkten, oavsett kategori.' },
      {
        num: '02',
        title: 'Identifiera',
        desc: 'Loopa räknar ut vad produkten är och hittar relevant produktinformation.',
      },
      {
        num: '03',
        title: 'Skick, pris och värde',
        desc: 'Skick och marknadsdata hjälper till att ta fram ett rekommenderat återförsäljningspris.',
      },
      {
        num: '04',
        title: 'Redo för återförsäljning',
        desc: 'Loopa skapar en strukturerad annons, redo att publiceras var du än säljer.',
      },
    ],
    identifyTags: ['Varumärke', 'Modell', 'Konfiguration', 'Mått', 'Material', 'Färg'],
  },
  generate: {
    heading: 'Generera med Loopa',
    subheading: 'Från bilder till färdig annons.',
    fashionGateLabel: 'Plagg + detaljbild',
    furnitureGateLabel: 'Säljarbilder',
    generateButton: 'Generera',
    generating: 'Genererar...',
    fashionResultLabel: 'Genererad annons',
  },
  generatorPreview: {
    conditionLabel: 'Skick',
    priceLabel: 'Pris',
    creditLabel: 'Tillgodo',
    rangeLabel: 'Uppskattat värde',
    descriptionLabel: 'Genererad beskrivning',
  },
  listingDemo: {
    sellerPhotos: 'Säljarfoton',
    loopaListing: 'Loopa-annons',
    published: 'Publicerad',
    productTitle: 'IKEA SÖDERHAMN 3-sitssoffa',
    productSubtitle: 'Vit · Avtagbar klädsel',
    brandLabel: 'Varumärke',
    brandValue: 'IKEA',
    modelLabel: 'Modell',
    modelValue: 'SÖDERHAMN',
    configLabel: 'Konfiguration',
    configValue: '3-sits, utan armstöd',
    dimensionsLabel: 'Mått',
    dimensionsValue: '198 x 99 x 83 cm',
    materialLabel: 'Material',
    materialValue: 'Klädsel i bomull/polyester',
    colorLabel: 'Färg',
    colorValue: 'Vit (Blekinge)',
    conditionLabel: 'Skick',
    conditionValue: 'Mycket bra, inga fläckar eller skador',
    estValueLabel: 'Uppskattat värde',
    estValueValue: '3 200-3 800 kr',
    descriptionLabel: 'Genererad beskrivning',
    description:
      'SÖDERHAMN är gjord för att sjunka ner i. De djupa, generösa sitsarna och mjuka ryggdynorna ger ett lågt och avslappnat sittande, och eftersom den saknar armstöd är den lätt att ställa mot en vägg eller kombinera med en divandel.\n\nKlädseln i vitt är avtagbar och maskintvättbar, så den är enkel att hålla fräsch. Ram och ryggdynor är i mycket bra skick utan fläckar, revor eller rökdoft. Mått 198 x 99 x 83 cm och går att plocka isär för enkel transport. Upphämtning i Stockholm.',
    askButton: 'Ställ frågor',
    priceLabel: 'Pris',
    priceValue: '3 500 kr',
    priceNote: 'Fast pris · ingen förhandling',
    buyNow: 'Köp nu',
  },
  chat: {
    title: 'Ställ frågor',
    subtitle: 'IKEA SÖDERHAMN 3-sitssoffa',
    placeholder: 'Skriv din fråga...',
    send: 'Skicka',
    close: 'Stäng',
    localDemoBadge: 'Lokal demo',
    thinking: 'Skriver...',
    greeting: 'Hej! Fråga mig om skick, mått, material eller pris för den här soffan.',
    suggested: [
      'Finns det några skador?',
      'Går klädseln att tvätta?',
      'Vad är måtten?',
      'Är det verkligen en SÖDERHAMN?',
      'Hur fungerar leveransen?',
      'Kan priset sänkas?',
    ],
  },
  buyFlow: {
    summaryTitle: 'Bekräfta köp',
    summaryItemLabel: 'Vara',
    summaryPriceLabel: 'Pris',
    summaryContinue: 'Välj leveranstid',
    summaryDisclaimer: 'Detta är en demo av köpflödet. Ingen betalning sker.',
    deliveryHeading: 'Välj 3 leveranstider',
    deliveryHelper: 'Välj tre tider som fungerar för dig. Säljaren bekräftar en av dem.',
    deliveryCounter: (n) => `${n} av 3 valda`,
    deliverySend: 'Skicka till säljaren',
    waitingHeading: 'Väntar på säljarens bekräftelse...',
    waitingSub: 'Det här tar vanligtvis bara ett ögonblick.',
    confirmedHeading: 'Säljaren bekräftade leverans',
    confirmedSub: 'Bekräftad tid:',
    confirmedContinue: 'Fortsätt till leverans',
    trackerHeading: 'Tiptapp-leverans',
    trackerDisclaimer: 'Simulerad leverans för demo, ingen verklig Tiptapp-integration.',
    trackerStages: ['Upphämtning bokad', 'Förare på väg', 'Upphämtad', 'På väg till dig', 'Levererad'],
    doneHeading: 'Tack för ditt köp!',
    doneSub: 'Din IKEA SÖDERHAMN har levererats.',
    doneButton: 'Klar',
    close: 'Stäng',
    back: 'Tillbaka',
  },
  brands: {
    heading: 'Lansera en egen secondhandkanal utan att bygga infrastrukturen själv.',
    body: 'Loopa identifierar plagget, hämtar produktdata, bedömer skick, rekommenderar pris och förbereder återförsäljningen, så personalen främst behöver verifiera och godkänna plagget vid ankomst.',
    keepsHeading: 'Varumärket äger',
    keeps: ['Kundrelationen', 'Butiken', 'Prisreglerna', 'Lagret', 'Transaktionen'],
    automatesHeading: 'Loopa automatiserar',
    automates: [
      'Produktidentifiering',
      'Produktdata',
      'Skickbedömning',
      'Prisrekommendation',
      'Inbyteslogik',
      'Förberedelse av annons',
      'Lager- och godkännandeflöde',
      'Återförsäljningsflöde',
    ],
    cta: 'Läs mer',
    pilotCta: 'Utforska en recommerce-pilot',
    exampleLabel: 'Exempel på butikskoncept · Soffadirekt',
    poweredBy: 'Drivs av',
    tabFashion: 'Mode',
    tabFurniture: 'Möbler',
  },
  brandExperience: {
    heading: 'Se hur Loopa fungerar för',
    fashionSubtext: 'Ett modevarumärkes recommerce-resa',
    furnitureSubtext: 'Möbelexemplet med Soffadirekt',
  },
  brandsDemo: {
    heading: 'Så fungerar Loopa för ett modevarumärke.',
    body: 'Från kundens garderob till varumärkets egen secondhandkanal.',
    stageLabels: ['Sälj tillbaka', 'Loopa AI', 'Godkänn', 'Sälj igen'],
    resetLabel: 'Börja om',
    sell: {
      brandName: 'North Thread',
      itemName: 'Overshirt',
      newLabel: 'Ordinarie pris',
      newPrice: '1 999 kr',
      sellBackButton: 'Sälj tillbaka',
      twoPhotosNote: 'Två bilder räcker.',
      garmentPhotoLabel: 'Plaggfoto',
      labelPhotoLabel: 'Detaljbild',
      continueButton: 'Skicka in',
    },
    ai: {
      heading: 'Produkt identifierad',
      colorLabel: 'Färg',
      color: 'Marinblå',
      sizeLabel: 'Storlek',
      size: 'M',
      materialLabel: 'Material',
      material: 'Ekologisk bomull, tvillväv',
      conditionLabel: 'Skick',
      conditionValue: 'B+ · Mycket bra',
      eligibleLabel: 'Berättigad till inbyte',
      recommendedPriceLabel: 'Rekommenderat andrahandspris',
      recommendedPrice: '999 kr',
      offerHeading: 'Illustrativt erbjudande vid inbyte',
      offerCash: '400 kr kontant',
      offerCredit: '500 kr i tillgodo',
      continueButton: 'Skicka till varumärket',
    },
    approve: {
      heading: 'Inkommande inbyte',
      automationNote:
        'Loopa har redan identifierat, strukturerat, skickbedömt och prissatt varan, personalen behöver främst verifiera skicket och godkänna den vid ankomst.',
      customerLabel: 'Kund',
      customerValue: 'Exempelkund',
      productLabel: 'Produkt',
      conditionLabel: 'AI-bedömt skick',
      suggestedPriceLabel: 'Rekommenderat pris',
      suggestedCreditLabel: 'Föreslaget tillgodo',
      approveButton: 'Godkänn',
      rejectButton: 'Neka',
      approvedNote: 'Tillgodo utfärdat',
      inventoryNote: 'Secondhand-lager +1',
      rejectedNote: 'Varan nekades i den här demon.',
      tryAgainButton: 'Försök igen',
    },
    resell: {
      brandPageLabel: 'Varumärkets produktsida',
      preLovedLabel: 'Begagnat',
      preLovedPrice: '999 kr',
      available: '1 i lager',
      secondhandUrl: 'varumarke.se/secondhand',
      productCardName: 'Begagnad Overshirt',
      conditionLabel: 'Skick',
      conditionValue: 'Mycket bra',
      brandOwnsChip: 'Varumärket äger kunden och butiken',
      loopaPowersChip: 'Loopa driver infrastrukturen bakom',
    },
  },
  storefront: {
    searchPlaceholder: 'Sök bland begagnade möbler',
    account: 'Konto',
    cart: 'Varukorg',
    categories: ['Soffor', 'Divansoffor', 'Fåtöljer', 'Soffbord', 'Sängbord', 'Förvaring'],
    kicker: 'SOFFADIREKT SECOND HAND',
    heading: 'Köp och sälj begagnade möbler från Soffadirekt.',
    body: 'Sälj din gamla soffa på några minuter och få tillgodo i butik, eller hitta en begagnad nära dig.',
    sellCta: 'Sälj din soffa',
    browseCta: 'Handla second hand',
    valuateTitle: 'Värdera din soffa',
    valuateSteps: ['Ladda upp några foton', 'Loopa identifierar modellen', 'Få ett direkt erbjudande'],
    estimatedLabel: 'Uppskattat andrahandsvärde',
    creditLabel: 'Tillgodo hos Soffadirekt',
    bonusNote: '+15 % bonus som tillgodo',
    pickupNote: 'Fri upphämtning i Stockholm, Göteborg och Malmö',
    nearYou: 'Tillgängligt nära dig',
    listingsCount: '128 annonser',
    viewListing: 'Visa annons →',
  },
  furnitureProof: {
    heading: 'Möbler: samma teknik, i praktiken.',
    body: 'Loopa byggdes först för möbler. Soffadirekt visar samma identifiering, skick och värdering som mode-exemplet ovan, applicerat på en annan produktkategori.',
    identifiedHeading: 'Produkt identifierad',
    brandLabel: 'Varumärke',
    brand: 'Swedese',
    modelLabel: 'Modell',
    model: 'Lamino',
  },
  brandValue: {
    heading: 'Ekonomin i en egen recommerce-kanal.',
    pillars: [
      {
        title: 'Väx',
        tagline: 'Tjäna på samma produkt mer än en gång',
        items: [
          {
            h: 'Tjäna på samma produkt mer än en gång',
            b: 'När en produkt kommer tillbaka till varumärket kan den bli säljbart lager igen, i stället för att försvinna in i en extern andrahandsmarknad.',
          },
          {
            h: 'Skapa en ny recommerce-intäkt utan att bygga hela systemet internt',
            b: 'Loopa levererar identifiering, skickbedömning och återförsäljningsflöde som en färdig tjänst ovanpå er befintliga handel.',
          },
        ],
      },
      {
        title: 'Behåll',
        tagline: 'Gör säljaren till nästa kund',
        items: [
          {
            h: 'Gör säljaren till nästa kund',
            b: 'Tillgodo skapar en naturlig anledning för kunden att komma tillbaka och handla igen.',
          },
          {
            h: 'Behåll relationen när produkten byter ägare',
            b: 'I stället för att kundrelationen tar slut vid inbytet fortsätter den in i nästa köp.',
          },
        ],
      },
      {
        title: 'Förstå',
        tagline: 'Se vad som händer efter första försäljningen',
        items: [
          {
            h: 'Se efterfrågan, värdebeständighet och produktlivslängd efter första försäljningen',
            b: 'Återförsäljning kan ge insikt om efterfrågan, värdebeständighet, produktlivslängd, skickmönster och inbytesbeteende.',
          },
          {
            h: 'Insikt, inte gissningar',
            b: 'Data byggs upp i takt med volym. Vi är tydliga med vad som är verifierat och vad som fortfarande är tidigt.',
          },
        ],
      },
      {
        title: 'Automatisera',
        tagline: 'Ta bort manuellt recommerce-arbete',
        items: [
          {
            h: 'Identifiering, produktdata, skick, prissättning och återförsäljning i ett sammanhängande flöde',
            b: 'Det gör att personalen främst behöver verifiera produkten när den faktiskt anländer.',
          },
          {
            h: 'Ett flöde, inte flera system',
            b: 'Inbyte, lager, annonsering och butik hänger ihop i stället för att vara separata verktyg som måste synkas för hand.',
          },
        ],
      },
    ],
  },
  technology: {
    heading: 'Byggt för produkter som redan finns.',
    body: 'Loopa är ett återanvändbart infrastrukturlager för recommerce, byggt för att kopplas till varumärkens egna system snarare än att vara en fristående marknadsplats.',
    layer1Label: 'Produktintelligens',
    layer1Items: ['Identitet', 'Specifikationer', 'Skick', 'Värde'],
    layer2Label: 'Recommerce-arbetsflöden',
    layer2Items: ['Inbyte', 'Annonser', 'Lager', 'Butik', 'Integrationer'],
    currentLabel: 'Nu',
    futureLabel: 'Framtid',
    current: ['Möbler', 'Mode'],
    future: ['Elektronik', 'Fordon', 'Sport', 'Övriga kategorier'],
  },
  about: {
    heading: 'Om Loopa',
    body: 'Loopa grundades i Stockholm av Victor Ruiz, Isac Ekelund och Benjamin Jonsson Östlund. Företaget började med att på riktigt hjälpa människor sälja begagnade möbler, och att göra det manuellt visade hur mycket arbete som sker innan en produkt ens kan säljas: identifiering, produktresearch, prissättning och att skapa annonsen. Den erfarenheten fick oss att bygga teknik som automatiserar det.',
    badge1: '2:a plats · Årets Innovation · UF SM',
    badge2: '2:a plats · Årets UF-företag · UF SM',
    originNote: 'Loopa startade som ett UF-företag på Östra Real i Stockholm.',
  },
  team: {
    heading: 'Team',
    members: [
      {
        name: 'Victor Ruiz',
        role: 'Medgrundare & CTO',
        bio: 'Arbetar med produkt och kommersiella partnerskap.',
      },
      {
        name: 'Isac Ekelund',
        role: 'Medgrundare & VD',
        bio: 'Arbetar med teknik och produktutveckling.',
      },
      {
        name: 'Benjamin Jonsson Östlund',
        role: 'Medgrundare & CFO',
        bio: 'Arbetar med drift och varumärke.',
      },
    ],
  },
  advisors: {
    heading: 'Rådgivare',
    body: 'Vi har stöd av erfarna ledare inom AI, teknik, entreprenörskap, investeringar, varumärke och digitala industrier.',
  },
  contact: {
    heading: 'Låt oss bygga second hand tillsammans.',
    body: 'Är du ett varumärke, en handlare eller en marknadsplats som utforskar recommerce? Vi vill gärna prata.',
    cta: 'Kontakta oss för samarbete',
    generalNote: 'Allmänna frågor:',
    form: {
      name: 'Namn',
      company: 'Företag',
      email: 'E-post',
      message: 'Meddelande',
      submit: 'Skicka meddelande',
      submitting: 'Skickar...',
      success: 'Tack! Vi hör av oss snart.',
      errorRequired: 'Obligatoriskt fält',
      errorEmail: 'Ange en giltig e-postadress',
    },
  },
  footer: {
    tagline: 'Automatiserad mjukvara för second hand. Från möbler till mode.',
    location: 'Stockholm, Sverige',
  },
  common: {
    stockholm: 'Stockholm, Sverige',
    linkedin: 'LinkedIn',
    currency: 'kr',
    illustrativeDemo: 'Illustrativ demo',
    or: 'eller',
  },
  brandsPage: {
    hero: {
      eyebrow: 'För varumärken',
      titleLine1: 'Era produkter säljs redan igen.',
      titleLine2: 'Gör ert varumärke till en del av nästa försäljning.',
      subtitle: 'En egen secondhandkanal som skapar nya intäkter, tar kunder tillbaka — och där Loopa sköter det svåra.',
      ctaPrimary: 'Se er egen secondhandbutik',
      ctaSecondary: 'Prata med oss',
      exampleSuffix: 'exempelprodukt',
    },
    valueWall: {
      heading1: 'Resale är inte ett hållbarhetsprojekt.',
      heading2: 'Det är en tillväxtkanal.',
      stats: [
        {
          value: '3×',
          title: 'Snabbare tillväxt',
          body: 'Secondhandmarknaden väntas växa ungefär tre gånger snabbare än den traditionella marknaden.',
        },
        {
          value: '~50%',
          title: 'Nya kunder',
          body: 'Omkring hälften av köparna i varumärkesägd resale är nya för varumärket — in till en lägre prispunkt.',
        },
        {
          value: '100%',
          title: 'Ert ägande',
          body: 'Kundrelationen, produktdatan och varumärkesupplevelsen stannar hos er — inte hos en extern marknadsplats.',
        },
      ],
      sourceNote: 'Marknadssiffror: ThredUp Resale Report / GlobalData samt publicerade resultat från varumärkesägda resale-program — inte Loopa-kunddata.',
    },
    preview: {
      eyebrow: 'Live preview',
      heading: 'Se er egen secondhandbutik.',
      subheading: 'Skriv in er webbadress — Loopa hittar era riktiga produkter och bygger en preview på ungefär tio sekunder.',
      urlSrLabel: 'Er hemsida',
      placeholder: 'https://ertvarumärke.se',
      submitIdle: 'Skapa preview',
      submitLoading: 'Bygger…',
      tryLabel: 'Eller testa med',
      statusPartial: (count, min) =>
        `Hittade bara ${count} produkt${count === 1 ? '' : 'er'} (behöver minst ${min}) — visar ett illustrativt exempel istället.`,
      statusEmpty: (domain) => `Kunde inte hitta produkter på ${domain} — visar ett illustrativt exempel istället.`,
      loadingSteps: ['Hittar era produkter…', 'Väljer rena produktbilder…', 'Bygger er butik…'],
      // Swedish genitive: names already ending in s/x/z take no extra "s"
      // ("Deadwood Studios secondhandbutik", not "Deadwood Studioss").
      successHeading: (company) =>
        company
          ? `Så här kan ${/[sxz]$/i.test(company) ? company : `${company}s`} secondhandbutik se ut`
          : 'Så här kan er secondhandbutik se ut',
      successBadge: (count) => `${count} riktiga produkter hittade`,
      idleNote: 'Illustrativt exempel — skriv in er adress ovan så byggs previewen av era egna produkter.',
      honesty: 'Previewen byggs från era publika produktsidor. Priser är uppskattningar. Vi sparar ingen data.',
      ctaLead: 'Det här är en preview. Vill ni ha den på riktigt?',
      ctaButton: 'Prata med oss',
      conditionExample: 'Skick: exempel',
      estimateLabel: 'Exempel',
      integrationHeading: 'Hellre direkt på produktsidan?',
      integrationBody:
        'Secondhandalternativet kan även visas bredvid nypriset på era befintliga produktsidor — samma data, ingen separat butik.',
    },
    productPageMock: {
      ny: 'Ny',
      secondhandAlternativ: 'Secondhandalternativ',
      fromLabel: (price) => `Från ${price}`,
      availableNote: (grade) => `2 tillgängliga · Skick ${grade}`,
      ctaSeeSecondhand: 'Se secondhand',
      priceUnknown: 'Pris okänt',
    },
    ownIt: {
      heading1: 'Kunden säljer produkten vidare oavsett.',
      heading2: 'Frågan är bara var.',
      todayLabel: 'Idag',
      todaySteps: ['Kund', 'Extern marknadsplats', 'Ny ägare'],
      todayBody: 'Försäljningen, relationen och datan hamnar hos någon annan.',
      withLoopaLabel: 'Med Loopa',
      withLoopaSteps: ['Kund', 'Er resale', 'Ny ägare', 'Framtida kund'],
      withLoopaBody: 'Varumärket är med hela vägen till nästa ägare — och nästa köp.',
    },
    hardPart: {
      heading: 'En secondhandbutik är den enkla delen.',
      subheading: 'Loopa automatiserar det som gör recommerce svårt.',
      sellerLine: 'Säljaren laddar upp några bilder. Resten sker automatiskt.',
      pipeline: ['Identifiera', 'Bedöm skick', 'Värdera', 'Välj flöde', 'Skapa listing', 'Sälj igen'],
      aiAssessed: 'Loopa AI-bedömd',
      conditionPrefix: 'Skick',
      trustLine: 'Konsekvent produktdata och skickbedömning — tryggare för köparen, mer värde för er.',
      exampleNote: 'Exempel på skickbedömning',
    },
    models: {
      eyebrow: 'Er modell, er webshop',
      heading: 'In i er befintliga webshop. Inte ett nytt IT-projekt.',
      subheading: 'Börja med det flöde som passar er idag — växla eller kombinera när det behövs.',
      flexNote: 'Ni behöver inte välja en modell för allt — olika produkter kan gå olika vägar, efter era regler.',
      closing: 'Loopa anpassas efter er verksamhet, inte tvärtom.',
    },
    finalCta: {
      heading1: 'Era produkter är redan en del av secondhandmarknaden.',
      heading2: 'Låt ert varumärke vara det också.',
      body: 'Vi bygger upplägget tillsammans med er, utifrån era produkter, er webshop och hur ni faktiskt vill arbeta.',
      ctaTalk: 'Prata med oss',
    },
  },
  secondhandPage: {
    hero: {
      eyebrow: 'För secondhandaktörer',
      titleLine1: 'Från bilder till SEO-redo produkt.',
      titleAccent: 'Automatiskt.',
      subtitle: 'Loopa researchar produkten, bedömer skicket och skapar en komplett produktlisting redo för er webshop.',
      subtitle2: 'Få fler produkter online med mindre manuellt arbete.',
      ctaPrimary: 'Testa på en produkt',
      ctaSecondary: 'Boka möte',
    },
    why: {
      heading: 'Varför Loopa',
      values: [
        { title: 'Få ut fler produkter', body: 'Mer av inkommande lager kan bli digitalt säljbart.' },
        { title: 'Minska manuellt arbete', body: 'Produktresearch, copy och struktur automatiseras.' },
        { title: 'Bygg ett produktminne', body: 'Återanvänd produktdata när samma modeller återkommer.' },
        { title: 'SEO-redo från början', body: 'Varje produkt får strukturerad ecommerce- och SEO-data.' },
      ],
    },
    generator: {
      stepOf: (n, total) => `Steg ${n} av ${total}`,
      mode: {
        stepLabel: 'Välj kategori',
        heading: 'Vad vill du skapa en produkt av?',
        continueButton: 'Fortsätt',
      },
      input: {
        stepLabel: (categoryLabel) => categoryLabel,
        heading: 'Ladda upp bilder',
        changeCategory: 'Byt kategori',
        brandLabel: 'Märke',
        brandPlaceholder: 't.ex. Swedese',
        modelLabel: 'Modell',
        modelPlaceholder: 't.ex. Lamino',
        fashionFieldsHelper: 'Frivilligt — men allt du redan vet gör identifieringen betydligt säkrare. Stilkoden identifierar ofta exakt originalprodukt.',
        fashionBrandLabel: 'Märke (valfritt)',
        fashionBrandPlaceholder: 't.ex. Acne Studios',
        styleCodeLabel: 'Stilkod/artikelnr (valfritt)',
        styleCodePlaceholder: 't.ex. B90371-900',
        sizeLabel: 'Storlek (valfritt)',
        sizePlaceholder: 't.ex. M / EU 48',
        productHeadline: 'Produktbilder',
        productHelper: 'Ladda upp tydliga bilder av produkten från flera vinklar.',
        labelHeadline: 'Etiketter',
        labelBadge: 'Valfritt',
        labelHelper: 'Om produkten har en etikett rekommenderar vi starkt att du laddar upp den. Det ger ofta betydligt bättre och säkrare resultat.',
        labelExamples: {
          furniture: 'Tillverkaretikett, modellnummer, produktetikett, etikett på undersida/baksida.',
          fashion: 'Märkesetikett, storlek, material/tvättråd, artikelnummer.',
        },
        productDropHint: (min, max) => `${min}–${max} bilder, JPG/PNG`,
        labelDropHint: (max) => `upp till ${max} bilder`,
        clickToUpload: 'Klicka för att ladda upp',
        minRequired: (min) => `Minst ${min} bilder krävs.`,
        removeImage: 'Ta bort bild',
        addMore: 'Lägg till fler bilder',
        continueButton: 'Fortsätt',
      },
      website: {
        stepLabel: 'Valfritt',
        heading: 'Anpassa för er webshop',
        changeImages: 'Byt bilder',
        urlLabel: 'Webbshopens URL',
        urlPlaceholder: 'https://example.se',
        urlHelper: 'Loopa anpassar produktstrukturen, innehållet och SEO:n efter hur er webshop är uppbyggd idag.',
        errorPersistHint: 'Dina bilder och uppgifter finns kvar — inget behöver laddas upp igen.',
        retryButton: 'Försök igen',
        generateButton: 'Generera produkt',
      },
      loading: {
        steps: {
          furniture: ['Analyserar bilder', 'Researchar produktinformation', 'Bedömer skick', 'Skapar produkt & SEO'],
          fashion: ['Analyserar bilder', 'Läser etiketter & material', 'Bedömer skick', 'Skapar produkt & SEO'],
        },
        note: 'Kan ta upp till 90 sekunder vid hög belastning — vi väntar hellre in ett bra svar än att ge ett dåligt.',
        stillWorkingNote: 'Jobbar fortfarande — researchen tar lite längre än vanligt just nu.',
      },
      errors: {
        imagesUnreadable: 'Bilderna kunde inte läsas in. Försök igen.',
        genericFailed: 'Något gick fel. Försök igen om en liten stund.',
        unexpectedServer: (status) => `Servern svarade oväntat (${status}).`,
        genericFailedWithStatus: (status) => `Något gick fel (${status}).`,
        imagesExcludedNote: (count) => `${count} bild(er) kunde inte laddas upp och uteslöts.`,
      },
      result: {
        stepLabel: 'Klart',
        resetButton: 'Generera en ny produkt',
        adaptedFor: (domain) => `Anpassad för ${domain}`,
        observeLabel: 'Observera:',
        defaultCategory: 'Produkt',
        specifications: 'Specifikationer',
        noSpecifications: 'Inga specifikationer kunde fastställas.',
        condition: 'Skick',
        aiAssessed: 'AI-skickbedömd',
        notAssessed: 'Ej bedömt',
        uncertainAssessment: 'Osäker bedömning',
        aiDisclaimer: 'Bedömningen görs av AI utifrån de uppladdade bilderna, inte fysisk verifiering.',
        identityUncertainLabel: 'Kunde inte bekräftas mot bilderna',
        verifiedSourceBadge: 'Officiell källa',
        price: 'Pris',
        insufficientPricingData: 'Otillräckligt underlag för ett prisförslag',
        retailPriceLabel: 'Nypris (referens):',
        conditionText: 'Skicktext',
        seoReady: 'SEO-redo',
        seoReadyBadge: '✓ SEO-redo',
        adaptedForWebshop: (domain) => `Struktur, produktfält och SEO har anpassats efter er nuvarande webshop (${domain}).`,
        seoTitleLabel: 'SEO-titel',
        metaTitleLabel: 'Meta title',
        metaDescriptionLabel: 'Meta description',
        urlLabel: 'URL',
        imageAltLabel: 'Bild-alttext',
        structuredAttributesLabel: 'Strukturerade produktattribut',
        jsonLdSummary: 'Product JSON-LD (Schema.org)',
        structureNote: 'Produktinformationen struktureras för både kunden, sökmotorer och ert ehandelssystem.',
        readyToPublish: '✓ Redo att publiceras',
        workflowSteps: ['Bilder', 'Loopa', 'Granska', 'Publicera'],
        integrationNote: 'Loopa är byggt för att kopplas till ert befintliga ehandelssystem via integration eller import.',
        publishButton: 'Publicera till webshop',
        sourcesLabel: 'Produktinformation researchad från relevanta källor',
        editableHint: 'redigerbar',
        attributeSourceAria: (label) => `Källa för ${label}`,
      },
      publishModal: {
        heading: 'Redo för er webshop',
        body1: 'Du skapade precis en komplett produktlisting med produktdata, skickbedömning och SEO på bara några minuter.',
        body2: 'Tänk om hela ert inflöde fungerade så här.',
        integrationNote: 'Loopa kan kopplas till ert befintliga system via integration eller import.',
        ctaTalk: 'Prata med oss om en integration',
        ctaBack: 'Tillbaka till produkten',
      },
    },
  },
}

const en: Dictionary = {
  nav: {
    home: 'Home',
    about: 'About us',
    brands: 'For brands',
    secondhand: 'For secondhand sellers',
    contact: 'Contact us',
  },
  hero: {
    titleLine1: 'Automated software',
    titleLine2: 'for secondhand.',
    subtitle:
      'Loopa automates the work from product to resale: identification, product data, condition, pricing and sale.',
    categoryLine: 'For fashion, furniture and more product categories.',
    ctaPrimary: 'See how it works',
    ctaSecondary: 'For brands',
    stages: ['Photo', 'Identify', 'Data', 'Condition', 'Value', 'Ready'],
    readyBadge: 'Ready for resale',
  },
  howItWorks: {
    heading: 'From product to resale.',
    steps: [
      { num: '01', title: 'Capture the product', desc: 'Upload photos of the product, in any category.' },
      {
        num: '02',
        title: 'Identify',
        desc: 'Loopa works out what the product is and finds relevant product information.',
      },
      {
        num: '03',
        title: 'Condition, price and value',
        desc: 'Condition and market data help produce a recommended resale price.',
      },
      {
        num: '04',
        title: 'Ready for resale',
        desc: 'Loopa creates a structured listing, ready to publish wherever you sell.',
      },
    ],
    identifyTags: ['Brand', 'Model', 'Configuration', 'Dimensions', 'Material', 'Colour'],
  },
  generate: {
    heading: 'Generate with Loopa',
    subheading: 'From photos to a finished listing.',
    fashionGateLabel: 'Garment + detail photo',
    furnitureGateLabel: 'Seller photos',
    generateButton: 'Generate',
    generating: 'Generating...',
    fashionResultLabel: 'Generated listing',
  },
  generatorPreview: {
    conditionLabel: 'Condition',
    priceLabel: 'Price',
    creditLabel: 'Store credit',
    rangeLabel: 'Estimated value',
    descriptionLabel: 'Generated description',
  },
  listingDemo: {
    sellerPhotos: 'Seller photos',
    loopaListing: 'Loopa listing',
    published: 'Published',
    productTitle: 'IKEA SÖDERHAMN 3-seat sofa',
    productSubtitle: 'White · Removable cover',
    brandLabel: 'Brand',
    brandValue: 'IKEA',
    modelLabel: 'Model',
    modelValue: 'SÖDERHAMN',
    configLabel: 'Configuration',
    configValue: '3-seat, no armrests',
    dimensionsLabel: 'Dimensions',
    dimensionsValue: '198 x 99 x 83 cm',
    materialLabel: 'Material',
    materialValue: 'Cotton/polyester cover',
    colorLabel: 'Colour',
    colorValue: 'White (Blekinge)',
    conditionLabel: 'Condition',
    conditionValue: 'Very good, no stains or damage',
    estValueLabel: 'Estimated value',
    estValueValue: '3,200-3,800 SEK',
    descriptionLabel: 'Generated description',
    description:
      "SÖDERHAMN is made for sinking into. The deep, generous seats and soft back cushions give a low, relaxed seating position, and since it has no armrests it's easy to place against a wall or combine with a chaise section.\n\nThe white cover is removable and machine washable, so it's easy to keep fresh. The frame and back cushions are in very good condition with no stains, tears or smoke smell. Measures 198 x 99 x 83 cm and can be taken apart for easy transport. Pickup in Stockholm.",
    askButton: 'Ask questions',
    priceLabel: 'Price',
    priceValue: '3,500 SEK',
    priceNote: 'Fixed price · no negotiation',
    buyNow: 'Buy now',
  },
  chat: {
    title: 'Ask questions',
    subtitle: 'IKEA SÖDERHAMN 3-seat sofa',
    placeholder: 'Type your question...',
    send: 'Send',
    close: 'Close',
    localDemoBadge: 'Local demo',
    thinking: 'Typing...',
    greeting: 'Hi! Ask me about condition, dimensions, material or price for this sofa.',
    suggested: [
      'Are there any damages?',
      'Can the cover be washed?',
      'What are the dimensions?',
      'Is this really a SÖDERHAMN?',
      'How does delivery work?',
      'Can you lower the price?',
    ],
  },
  buyFlow: {
    summaryTitle: 'Confirm purchase',
    summaryItemLabel: 'Item',
    summaryPriceLabel: 'Price',
    summaryContinue: 'Choose delivery time',
    summaryDisclaimer: 'This is a demo of the purchase flow. No payment is made.',
    deliveryHeading: 'Choose 3 delivery times',
    deliveryHelper: 'Choose three times that work for you. The seller will confirm one of them.',
    deliveryCounter: (n) => `${n} of 3 selected`,
    deliverySend: 'Send to seller',
    waitingHeading: 'Waiting for seller confirmation...',
    waitingSub: 'This usually only takes a moment.',
    confirmedHeading: 'Seller confirmed delivery',
    confirmedSub: 'Confirmed time:',
    confirmedContinue: 'Continue to delivery',
    trackerHeading: 'Tiptapp delivery',
    trackerDisclaimer: 'Simulated delivery for demo purposes, not a live Tiptapp integration.',
    trackerStages: ['Pickup scheduled', 'Driver on the way', 'Picked up', 'On the way to you', 'Delivered'],
    doneHeading: 'Thanks for your purchase!',
    doneSub: 'Your IKEA SÖDERHAMN has been delivered.',
    doneButton: 'Done',
    close: 'Close',
    back: 'Back',
  },
  brands: {
    heading: 'Launch your own secondhand channel without building the infrastructure yourself.',
    body: 'Loopa identifies the garment, retrieves product data, assesses condition, recommends a price and prepares the resale listing, so staff mainly need to verify and approve the item on arrival.',
    keepsHeading: 'The brand keeps',
    keeps: ['The customer relationship', 'The storefront', 'Pricing rules', 'Inventory', 'The transaction'],
    automatesHeading: 'Loopa automates',
    automates: [
      'Product identification',
      'Product data',
      'Condition assessment',
      'Price recommendation',
      'Trade-in logic',
      'Listing preparation',
      'Inventory and approval workflow',
      'Resale workflow',
    ],
    cta: 'Read more',
    pilotCta: 'Explore a resale pilot',
    exampleLabel: 'Example store concept · Soffadirekt',
    poweredBy: 'Powered by',
    tabFashion: 'Fashion',
    tabFurniture: 'Furniture',
  },
  brandExperience: {
    heading: 'See how Loopa works for',
    fashionSubtext: "A fashion brand's recommerce journey",
    furnitureSubtext: 'The furniture example with Soffadirekt',
  },
  brandsDemo: {
    heading: 'How Loopa works for a fashion brand.',
    body: "From the customer's closet to the brand's own secondhand channel.",
    stageLabels: ['Sell back', 'Loopa AI', 'Approve', 'Resell'],
    resetLabel: 'Start over',
    sell: {
      brandName: 'North Thread',
      itemName: 'Overshirt',
      newLabel: 'Original price',
      newPrice: '1,999 SEK',
      sellBackButton: 'Sell back',
      twoPhotosNote: 'Two photos is all it takes.',
      garmentPhotoLabel: 'Garment photo',
      labelPhotoLabel: 'Detail photo',
      continueButton: 'Submit',
    },
    ai: {
      heading: 'Product identified',
      colorLabel: 'Colour',
      color: 'Navy',
      sizeLabel: 'Size',
      size: 'M',
      materialLabel: 'Material',
      material: 'Organic cotton, twill',
      conditionLabel: 'Condition',
      conditionValue: 'B+ · Very good',
      eligibleLabel: 'Eligible for trade-in',
      recommendedPriceLabel: 'Recommended resale price',
      recommendedPrice: '999 SEK',
      offerHeading: 'Illustrative trade-in offer',
      offerCash: '400 SEK cash',
      offerCredit: '500 SEK store credit',
      continueButton: 'Send to brand',
    },
    approve: {
      heading: 'Incoming trade-in',
      automationNote:
        'Loopa has already identified, structured, condition-assessed and priced the item, staff mainly need to verify the condition and approve it on arrival.',
      customerLabel: 'Customer',
      customerValue: 'Example customer',
      productLabel: 'Product',
      conditionLabel: 'AI condition',
      suggestedPriceLabel: 'Recommended price',
      suggestedCreditLabel: 'Suggested credit',
      approveButton: 'Approve',
      rejectButton: 'Reject',
      approvedNote: 'Store credit issued',
      inventoryNote: 'Secondhand inventory +1',
      rejectedNote: 'The item was rejected in this demo.',
      tryAgainButton: 'Try again',
    },
    resell: {
      brandPageLabel: "Brand's product page",
      preLovedLabel: 'Pre-loved',
      preLovedPrice: '999 SEK',
      available: '1 available',
      secondhandUrl: 'brand.com/secondhand',
      productCardName: 'Pre-loved Overshirt',
      conditionLabel: 'Condition',
      conditionValue: 'Very good',
      brandOwnsChip: 'The brand owns the customer and the storefront',
      loopaPowersChip: 'Loopa powers the infrastructure underneath',
    },
  },
  storefront: {
    searchPlaceholder: 'Search secondhand furniture',
    account: 'Account',
    cart: 'Cart',
    categories: ['Sofas', 'Chaise sofas', 'Armchairs', 'Coffee tables', 'Bedside tables', 'Storage'],
    kicker: 'SOFFADIREKT SECONDHAND',
    heading: 'Buy and sell secondhand furniture from Soffadirekt.',
    body: 'Sell your old sofa in minutes and get store credit, or find a secondhand piece near you.',
    sellCta: 'Sell your sofa',
    browseCta: 'Shop secondhand',
    valuateTitle: 'Value your sofa',
    valuateSteps: ['Upload a few photos', 'Loopa identifies the model', 'Get an instant offer'],
    estimatedLabel: 'Estimated resale value',
    creditLabel: 'Store credit at Soffadirekt',
    bonusNote: '+15% bonus as store credit',
    pickupNote: 'Free pickup in Stockholm, Gothenburg and Malmö',
    nearYou: 'Available near you',
    listingsCount: '128 listings',
    viewListing: 'View listing →',
  },
  furnitureProof: {
    heading: 'Furniture: the same technology, in practice.',
    body: 'Loopa was originally built for furniture. Soffadirekt shows the same identification, condition and valuation as the fashion example above, applied to a different product category.',
    identifiedHeading: 'Product identified',
    brandLabel: 'Brand',
    brand: 'Swedese',
    modelLabel: 'Model',
    model: 'Lamino',
  },
  brandValue: {
    heading: 'The economics of your own recommerce channel.',
    pillars: [
      {
        title: 'Grow',
        tagline: 'Earn from the same product more than once',
        items: [
          {
            h: 'Earn from the same product more than once',
            b: 'When a product comes back to the brand, it can become sellable inventory again, instead of disappearing into an external resale market.',
          },
          {
            h: 'Create a new recommerce revenue line without building the whole system in-house',
            b: "Loopa delivers identification, condition assessment and a resale workflow as a ready service on top of your existing commerce.",
          },
        ],
      },
      {
        title: 'Retain',
        tagline: 'Turn the seller into your next customer',
        items: [
          {
            h: 'Turn the seller into your next customer',
            b: 'Store credit gives the customer a natural reason to come back and buy again.',
          },
          {
            h: 'Keep the relationship when the product changes owner',
            b: "Instead of the customer relationship ending at trade-in, it carries into the next purchase.",
          },
        ],
      },
      {
        title: 'Understand',
        tagline: 'See what happens after the first sale',
        items: [
          {
            h: 'See demand, value retention and product longevity after the first sale',
            b: 'Resale can surface insight into demand, value retention, product longevity, condition patterns and trade-in behaviour.',
          },
          {
            h: 'Insight, not guesswork',
            b: "Data builds up with volume. We're upfront about what's verified today and what's still early.",
          },
        ],
      },
      {
        title: 'Automate',
        tagline: 'Remove manual recommerce work',
        items: [
          {
            h: 'Identification, product data, condition, pricing and resale in one connected flow',
            b: 'That means staff mainly need to verify the product when it actually arrives.',
          },
          {
            h: 'One workflow, not several systems',
            b: 'Trade-in, inventory, listings and storefront stay connected instead of being separate tools that need manual syncing.',
          },
        ],
      },
    ],
  },
  technology: {
    heading: 'Built for products that already exist.',
    body: "Loopa is a reusable recommerce infrastructure layer, built to connect to a brand's own systems rather than operate as a standalone marketplace.",
    layer1Label: 'Product intelligence',
    layer1Items: ['Identity', 'Specifications', 'Condition', 'Value'],
    layer2Label: 'Recommerce workflows',
    layer2Items: ['Trade-in', 'Listings', 'Inventory', 'Storefront', 'Integrations'],
    currentLabel: 'Now',
    futureLabel: 'Future',
    current: ['Furniture', 'Fashion'],
    future: ['Electronics', 'Vehicles', 'Sports', 'Other categories'],
  },
  about: {
    heading: 'About Loopa',
    body: "Loopa was founded in Stockholm by Victor Ruiz, Isac Ekelund and Benjamin Jonsson Östlund. The company started by genuinely helping people sell secondhand furniture, and doing it manually showed how much work goes into a product before it can even be sold: identification, product research, pricing and creating the listing. That experience is what led us to build technology that automates it.",
    badge1: '2nd place · Innovation of the Year · UF SM',
    badge2: '2nd place · UF Company of the Year · UF SM',
    originNote: 'Loopa started as a Young Enterprise (UF) company at Östra Real in Stockholm.',
  },
  team: {
    heading: 'Team',
    members: [
      {
        name: 'Victor Ruiz',
        role: 'Co-founder & CTO',
        bio: 'Works on product and commercial partnerships.',
      },
      {
        name: 'Isac Ekelund',
        role: 'Co-founder & CEO',
        bio: 'Works on technology and product development.',
      },
      {
        name: 'Benjamin Jonsson Östlund',
        role: 'Co-founder & CFO',
        bio: 'Works on operations and brand.',
      },
    ],
  },
  advisors: {
    heading: 'Advisors',
    body: "We're supported by experienced leaders in AI, technology, entrepreneurship, investment, brand and digital industries.",
  },
  contact: {
    heading: "Let's build secondhand together.",
    body: 'Are you a brand, retailer or marketplace exploring recommerce? We would love to talk.',
    cta: 'Contact us to partner',
    generalNote: 'General inquiries:',
    form: {
      name: 'Name',
      company: 'Company',
      email: 'Email',
      message: 'Message',
      submit: 'Send message',
      submitting: 'Sending...',
      success: "Thanks! We'll be in touch soon.",
      errorRequired: 'Required field',
      errorEmail: 'Enter a valid email address',
    },
  },
  footer: {
    tagline: 'Automated software for secondhand. From furniture to fashion.',
    location: 'Stockholm, Sweden',
  },
  common: {
    stockholm: 'Stockholm, Sweden',
    linkedin: 'LinkedIn',
    currency: 'SEK',
    illustrativeDemo: 'Illustrative demo',
    or: 'or',
  },
  brandsPage: {
    hero: {
      eyebrow: 'For brands',
      titleLine1: 'Your products are already being resold.',
      titleLine2: 'Make your brand part of the next sale.',
      subtitle: 'Your own secondhand channel that creates new revenue, brings customers back — and where Loopa runs the hard part.',
      ctaPrimary: 'See your own secondhand store',
      ctaSecondary: 'Talk to us',
      exampleSuffix: 'example product',
    },
    valueWall: {
      heading1: "Resale isn't a sustainability project.",
      heading2: "It's a growth channel.",
      stats: [
        {
          value: '3×',
          title: 'Faster growth',
          body: 'The secondhand market is projected to grow roughly three times faster than the traditional market.',
        },
        {
          value: '~50%',
          title: 'New customers',
          body: 'Around half of the buyers in brand-owned resale are new to the brand — entering at a lower price point.',
        },
        {
          value: '100%',
          title: 'Your ownership',
          body: 'The customer relationship, product data, and brand experience stay with you — not with an external marketplace.',
        },
      ],
      sourceNote: 'Market figures: ThredUp Resale Report / GlobalData and published results from brand-owned resale programs — not Loopa customer data.',
    },
    preview: {
      eyebrow: 'Live preview',
      heading: 'See your own secondhand store.',
      subheading: 'Enter your web address — Loopa finds your real products and builds a preview in about ten seconds.',
      urlSrLabel: 'Your website',
      placeholder: 'https://yourbrand.com',
      submitIdle: 'Create preview',
      submitLoading: 'Building…',
      tryLabel: 'Or try',
      statusPartial: (count, min) =>
        `Only found ${count} product${count === 1 ? '' : 's'} (needs at least ${min}) — showing an illustrative example instead.`,
      statusEmpty: (domain) => `Couldn't find products on ${domain} — showing an illustrative example instead.`,
      loadingSteps: ['Finding your products…', 'Selecting clean product images…', 'Building your store…'],
      // English genitive: names ending in "s" take a bare apostrophe.
      successHeading: (company) =>
        company
          ? `This is what ${/s$/i.test(company) ? `${company}'` : `${company}'s`} secondhand store could look like`
          : 'This is what your secondhand store could look like',
      successBadge: (count) => `${count} real products found`,
      idleNote: 'Illustrative example — enter your address above and the preview is built from your own products.',
      honesty: "The preview is built from your public product pages. Prices are estimates. We don't store any data.",
      ctaLead: 'This is a preview. Want the real thing?',
      ctaButton: 'Talk to us',
      conditionExample: 'Condition: example',
      estimateLabel: 'Example',
      integrationHeading: 'Prefer it on the product page?',
      integrationBody:
        'The secondhand option can also appear next to the new price on your existing product pages — same data, no separate store.',
    },
    productPageMock: {
      ny: 'New',
      secondhandAlternativ: 'Secondhand option',
      fromLabel: (price) => `From ${price}`,
      availableNote: (grade) => `2 available · Condition ${grade}`,
      ctaSeeSecondhand: 'See secondhand',
      priceUnknown: 'Price unknown',
    },
    ownIt: {
      heading1: 'The customer resells the product either way.',
      heading2: 'The only question is where.',
      todayLabel: 'Today',
      todaySteps: ['Customer', 'External marketplace', 'New owner'],
      todayBody: 'The sale, the relationship, and the data end up with someone else.',
      withLoopaLabel: 'With Loopa',
      withLoopaSteps: ['Customer', 'Your resale', 'New owner', 'Future customer'],
      withLoopaBody: 'The brand stays in it all the way to the next owner — and the next purchase.',
    },
    hardPart: {
      heading: 'A secondhand store is the easy part.',
      subheading: 'Loopa automates what makes recommerce hard.',
      sellerLine: 'The seller uploads a few photos. The rest is automatic.',
      pipeline: ['Identify', 'Assess condition', 'Value', 'Choose flow', 'Create listing', 'Sell again'],
      aiAssessed: 'Loopa AI-assessed',
      conditionPrefix: 'Condition',
      trustLine: 'Consistent product data and condition grading — safer for the buyer, more value for you.',
      exampleNote: 'Example condition assessment',
    },
    models: {
      eyebrow: 'Your model, your webshop',
      heading: 'Into your existing webshop. Not a new IT project.',
      subheading: 'Start with the flow that fits you today — switch or combine when needed.',
      flexNote: "You don't have to choose one model for everything — different products can take different routes, by your rules.",
      closing: 'Loopa adapts to your business, not the other way around.',
    },
    finalCta: {
      heading1: 'Your products are already part of the secondhand market.',
      heading2: 'Let your brand be part of it too.',
      body: "We build the setup together with you, based on your products, your webshop, and how you actually want to work.",
      ctaTalk: 'Talk to us',
    },
  },
  secondhandPage: {
    hero: {
      eyebrow: 'For secondhand sellers',
      titleLine1: 'From photos to an SEO-ready product.',
      titleAccent: 'Automatically.',
      subtitle: 'Loopa researches the product, assesses its condition and creates a complete product listing, ready for your webshop.',
      subtitle2: 'Get more products online with less manual work.',
      ctaPrimary: 'Try it on a product',
      ctaSecondary: 'Book a meeting',
    },
    why: {
      heading: 'Why Loopa',
      values: [
        { title: 'Get more products out', body: 'More of your incoming stock can become digitally sellable.' },
        { title: 'Cut manual work', body: 'Product research, copy and structure are automated.' },
        { title: 'Build a product memory', body: 'Reuse product data whenever the same models come back around.' },
        { title: 'SEO-ready from the start', body: 'Every product gets structured ecommerce and SEO data.' },
      ],
    },
    generator: {
      stepOf: (n, total) => `Step ${n} of ${total}`,
      mode: {
        stepLabel: 'Choose category',
        heading: 'What do you want to create a product from?',
        continueButton: 'Continue',
      },
      input: {
        stepLabel: (categoryLabel) => categoryLabel,
        heading: 'Upload images',
        changeCategory: 'Change category',
        brandLabel: 'Brand',
        brandPlaceholder: 'e.g. Swedese',
        modelLabel: 'Model',
        modelPlaceholder: 'e.g. Lamino',
        fashionFieldsHelper: 'Optional — but everything you already know makes identification noticeably more reliable. The style code often identifies the exact original product.',
        fashionBrandLabel: 'Brand (optional)',
        fashionBrandPlaceholder: 'e.g. Acne Studios',
        styleCodeLabel: 'Style code/item no. (optional)',
        styleCodePlaceholder: 'e.g. B90371-900',
        sizeLabel: 'Size (optional)',
        sizePlaceholder: 'e.g. M / EU 48',
        productHeadline: 'Product images',
        productHelper: 'Upload clear images of the product from several angles.',
        labelHeadline: 'Labels',
        labelBadge: 'Optional',
        labelHelper: 'If the product has a label, we strongly recommend uploading it. It often gives noticeably better and more reliable results.',
        labelExamples: {
          furniture: 'Manufacturer label, model number, product tag, label on the underside/back.',
          fashion: 'Brand label, size, material/care label, item number.',
        },
        productDropHint: (min, max) => `${min}–${max} images, JPG/PNG`,
        labelDropHint: (max) => `up to ${max} images`,
        clickToUpload: 'Click to upload',
        minRequired: (min) => `At least ${min} images required.`,
        removeImage: 'Remove image',
        addMore: 'Add more images',
        continueButton: 'Continue',
      },
      website: {
        stepLabel: 'Optional',
        heading: 'Adapt for your webshop',
        changeImages: 'Change images',
        urlLabel: 'Webshop URL',
        urlPlaceholder: 'https://example.com',
        urlHelper: "Loopa adapts the product structure, content and SEO to how your webshop is set up today.",
        errorPersistHint: 'Your images and details are kept — nothing needs to be uploaded again.',
        retryButton: 'Try again',
        generateButton: 'Generate product',
      },
      loading: {
        steps: {
          furniture: ['Analyzing images', 'Researching product information', 'Assessing condition', 'Creating product & SEO'],
          fashion: ['Analyzing images', 'Reading labels & materials', 'Assessing condition', 'Creating product & SEO'],
        },
        note: "Can take up to 90 seconds under high load — we'd rather wait for a good answer than give a poor one.",
        stillWorkingNote: 'Still working — the research is taking a little longer than usual right now.',
      },
      errors: {
        imagesUnreadable: 'The images could not be read. Please try again.',
        genericFailed: 'Something went wrong. Please try again shortly.',
        unexpectedServer: (status) => `The server responded unexpectedly (${status}).`,
        genericFailedWithStatus: (status) => `Something went wrong (${status}).`,
        imagesExcludedNote: (count) => `${count} image(s) could not be uploaded and were excluded.`,
      },
      result: {
        stepLabel: 'Done',
        resetButton: 'Generate a new product',
        adaptedFor: (domain) => `Adapted for ${domain}`,
        observeLabel: 'Note:',
        defaultCategory: 'Product',
        specifications: 'Specifications',
        noSpecifications: 'No specifications could be determined.',
        condition: 'Condition',
        aiAssessed: 'AI-assessed condition',
        notAssessed: 'Not assessed',
        uncertainAssessment: 'Uncertain assessment',
        aiDisclaimer: 'The assessment is made by AI based on the uploaded images, not physical verification.',
        identityUncertainLabel: 'Could not be confirmed against the photos',
        verifiedSourceBadge: 'Official source',
        price: 'Price',
        insufficientPricingData: 'Insufficient data for a price suggestion',
        retailPriceLabel: 'Retail price (reference):',
        conditionText: 'Condition description',
        seoReady: 'SEO ready',
        seoReadyBadge: '✓ SEO ready',
        adaptedForWebshop: (domain) => `Structure, product fields and SEO have been adapted to your current webshop (${domain}).`,
        seoTitleLabel: 'SEO title',
        metaTitleLabel: 'Meta title',
        metaDescriptionLabel: 'Meta description',
        urlLabel: 'URL',
        imageAltLabel: 'Image alt text',
        structuredAttributesLabel: 'Structured product attributes',
        jsonLdSummary: 'Product JSON-LD (Schema.org)',
        structureNote: 'The product information is structured for the customer, search engines and your ecommerce system alike.',
        readyToPublish: '✓ Ready to publish',
        workflowSteps: ['Images', 'Loopa', 'Review', 'Publish'],
        integrationNote: "Loopa is built to connect to your existing ecommerce system via integration or import.",
        publishButton: 'Publish to webshop',
        sourcesLabel: 'Product information researched from relevant sources',
        editableHint: 'editable',
        attributeSourceAria: (label) => `Source for ${label}`,
      },
      publishModal: {
        heading: 'Ready for your webshop',
        body1: 'You just created a complete product listing with product data, condition assessment and SEO in just a few minutes.',
        body2: 'Imagine if your entire inflow worked like this.',
        integrationNote: 'Loopa can be connected to your existing system via integration or import.',
        ctaTalk: 'Talk to us about an integration',
        ctaBack: 'Back to the product',
      },
    },
  },
}

export const dictionaries = { sv, en }
