import { useEffect, useState } from "react";
import "./butik.css";
import { navigate, useButikRoute } from "./router";
import CategoryScreen from "./screens/CategoryScreen";
import BrandScreen from "./screens/BrandScreen";
import ProductScreen from "./screens/ProductScreen";
import SearchScreen from "./screens/SearchScreen";
import OrderScreen from "./screens/OrderScreen";
import ButikProfile from "./screens/ButikProfile";
import ButikChrome from "./components/Chrome";

/**
 * Butiken.
 *
 * Ligger bredvid säljflödet, inte inuti det: App.tsx väljer mellan dem på adressen, precis som den
 * redan gör med det publika kortet och de juridiska sidorna. Det är samma app och samma konto, men
 * två olika saker att göra — och säljflödets tillstånd (bildrutor i minnet, ett halvfärdigt jobb)
 * har ingenting i ett rutnät att göra.
 */
export default function ButikApp() {
  const { route } = useButikRoute();

  useEffect(() => {
    document.title = titleFor(route);
  }, [route]);

  return (
    <ButikChrome>
        {route.name === "category" && <CategoryScreen slug={route.slug} />}
        {route.name === "brand" && <BrandScreen slug={route.slug} />}
        {route.name === "product" && <ProductScreen id={route.id} />}
        {route.name === "search" && <SearchScreen q={route.q} />}
        {route.name === "order" && <OrderScreen id={route.id} />}
        {route.name === "profile" && <ButikProfile />}
    </ButikChrome>
  );
}

function titleFor(route: ReturnType<typeof useButikRoute>["route"]): string {
  switch (route.name) {
    case "category": return "Kategori – Loopa Butik";
    case "brand": return `${route.slug} secondhand – Loopa Butik`;
    case "product": return "Möbel – Loopa Butik";
    case "search": return route.q ? `${route.q} – Loopa Butik` : "Alla möbler – Loopa Butik";
    case "order": return "Din order – Loopa";
    case "profile": return "Din profil – Loopa";
    default: return "Loopa Butik – köp begagnat, handla som nytt";
  }
}


