export interface TeamMember {
  name: string
  photo: string
  linkedin: string
}

export const TEAM: TeamMember[] = [
  {
    name: 'Victor Ruiz',
    photo: '/assets/people/victor.webp',
    linkedin: 'https://www.linkedin.com/in/victor-ruiz-6621b3360',
  },
  {
    name: 'Isac Ekelund',
    photo: '/assets/people/isac.webp',
    linkedin: 'https://www.linkedin.com/in/isac-ekelund-450ba3316',
  },
  {
    name: 'Benjamin Jonsson Östlund',
    photo: '/assets/people/benjamin.webp',
    linkedin: 'https://www.linkedin.com/in/benjamin-jonsson-östlund-2776692a7',
  },
]

export interface Advisor {
  name: string
  photo: string | null
  linkedin: string
  role: { sv: string; en: string }
  bio: { sv: string; en: string }
  tags: { sv: string[]; en: string[] }
}

export const ADVISORS: Advisor[] = [
  {
    name: 'David Edelsohn',
    photo: '/assets/people/david.webp',
    linkedin: 'https://www.linkedin.com/in/davidedelsohn',
    role: { sv: 'Alliances Manager, NVIDIA', en: 'Alliances Manager, NVIDIA' },
    bio: {
      sv: 'Teknikledare med decennier av erfarenhet inom AI, öppen källkod och storskaliga teknikekosystem.',
      en: 'Technology leader with decades of experience in AI, open source and large-scale technology ecosystems.',
    },
    tags: {
      sv: ['AI', 'Öppen källkod', 'Ekosystem'],
      en: ['AI', 'Open source', 'Ecosystem'],
    },
  },
  {
    name: 'Richard Jhang',
    photo: '/assets/people/richard.webp',
    linkedin: 'https://www.linkedin.com/in/richardjhang',
    role: {
      sv: 'Grundare, VD & General Partner · StratMinds · tidigare CIO, IBM',
      en: 'Founder, CEO & General Partner · StratMinds · former CIO, IBM',
    },
    bio: {
      sv: 'Investerare, operatör och rådgivare inom tillämpad AI med erfarenhet från enterprise-teknik, AI och bolagsbyggande.',
      en: 'Investor, operator and advisor in applied AI with experience from enterprise technology, AI and company building.',
    },
    tags: {
      sv: ['Bolagsbyggande', 'Enterprise-teknik', 'AI-investeringar'],
      en: ['Company building', 'Enterprise technology', 'AI investing'],
    },
  },
  {
    name: 'Peo Nilsson',
    photo: '/assets/people/peo.webp',
    linkedin: 'https://www.linkedin.com/in/peonilsson',
    role: {
      sv: 'Entreprenör & investerare · Medgrundare av Booli · Tidigare coach, Sting',
      en: 'Entrepreneur & investor · Co-founder of Booli · Former coach, Sting',
    },
    bio: {
      sv: 'Teknikentreprenör och investerare med erfarenhet av att bygga, finansiera och rådge teknikbolag och marknadsplatser.',
      en: 'Technology entrepreneur and investor experienced in building, financing and advising technology companies and marketplaces.',
    },
    tags: {
      sv: ['Entreprenörskap', 'Marknadsplatser', 'Investeringar'],
      en: ['Entrepreneurship', 'Marketplaces', 'Investing'],
    },
  },
  {
    name: 'Per Strömbäck',
    photo: '/assets/people/per.webp',
    linkedin: 'https://www.linkedin.com/in/perstroembaeck',
    role: { sv: 'VD · Spelbranschen (Swedish Games Industry)', en: 'CEO · Swedish Games Industry' },
    bio: {
      sv: 'Branschledare med bred erfarenhet inom digitala produkter, teknikekosystem och internationell branschutveckling.',
      en: 'Industry leader with broad experience in digital products, technology ecosystems and international industry development.',
    },
    tags: {
      sv: ['Digitala produkter', 'Branschutveckling'],
      en: ['Digital products', 'Industry development'],
    },
  },
  {
    name: 'Anthony Ford',
    photo: '/assets/people/anthony.webp',
    linkedin: 'https://www.linkedin.com/in/anthonydavidford',
    role: { sv: 'Marknadschef · PwC', en: 'Marketing Director · PwC' },
    bio: {
      sv: 'Senior marknads- och varumärkesledare med erfarenhet inom positionering, varumärkesstrategi och innovation.',
      en: 'Senior marketing and brand leader with experience in positioning, brand strategy and innovation.',
    },
    tags: {
      sv: ['Varumärkesstrategi', 'Marknadsföring', 'Positionering'],
      en: ['Brand strategy', 'Marketing', 'Positioning'],
    },
  },
  {
    name: 'Karin Ruiz',
    photo: '/assets/people/karin.webp',
    linkedin: 'https://www.linkedin.com/in/karinruiz',
    role: { sv: 'VD Sting · Tidigare coach', en: 'CEO Sting · Former coach' },
    bio: {
      sv: 'Senior affärsledare med bred erfarenhet inom kommersiell strategi, organisation och tillväxt.',
      en: 'Senior business leader with broad experience in commercial strategy, organisation and growth.',
    },
    tags: {
      sv: ['Ledarskap', 'Kommersiell strategi', 'Tillväxt'],
      en: ['Leadership', 'Commercial strategy', 'Growth'],
    },
  },
]
