import { Hero } from '../components/Hero'
import { HowItWorks } from '../components/HowItWorks'
import { GenerateWithLoopa } from '../components/GenerateWithLoopa'
import { ForBrands } from '../components/ForBrands'
import { BrandExperience } from '../components/BrandExperience'
import { BrandValue } from '../components/BrandValue'
import { Technology } from '../components/Technology'
import { About } from '../components/About'
import { Team } from '../components/Team'
import { Advisors } from '../components/Advisors'
import { Contact } from '../components/Contact'

export function HomePage() {
  return (
    <>
      <Hero />
      <HowItWorks />
      <GenerateWithLoopa />
      <ForBrands />
      <BrandExperience />
      <BrandValue />
      <Technology />
      <About />
      <Team />
      <Advisors />
      <Contact />
    </>
  )
}
