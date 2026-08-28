import { LanguageProvider } from './i18n/LanguageContext'
import { Nav } from './components/Nav'
import { Footer } from './components/Footer'
import { useRoute, useScrollToHash } from './router'
import { HomePage } from './pages/HomePage'
import { SecondhandPage } from './pages/SecondhandPage'
import { BrandsPage } from './pages/BrandsPage'
import { SellerPage } from './pages/SellerPage'

// Two entirely separate products sharing one deploy, deliberately isolated:
//   /            — the consumer seller product (its own shell, no B2B nav)
//   /company /brands /secondhand — the existing B2B experience (shared Nav+Footer)
// No visible navigation connects the two. See docs/SELLER_MVP_ARCHITECTURE.md.
const B2B_ROUTES = new Set(['/company', '/brands', '/secondhand'])

function App() {
  const pathname = useRoute()
  useScrollToHash(pathname)

  if (!B2B_ROUTES.has(pathname)) {
    // '/' and any unmatched path resolve to the seller product — it is the
    // new default experience at the root domain.
    return <SellerPage />
  }

  const page = pathname === '/secondhand' ? <SecondhandPage /> : pathname === '/brands' ? <BrandsPage /> : <HomePage />

  return (
    <LanguageProvider>
      <Nav />
      <main>{page}</main>
      <Footer />
    </LanguageProvider>
  )
}

export default App
