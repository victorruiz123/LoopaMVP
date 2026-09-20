/**
 * VAR DATA BOR: filer eller Postgres. Ett beslut, på ett ställe.
 *
 * Butiken, affärerna och inbjudningarna har var sin lagring med två ryggar, och alla tre valde rygg
 * på samma villkor: fanns SUPABASE_SERVICE_ROLE_KEY låg de i Postgres, annars i filer. Villkoret
 * stod skrivet tre gånger, och ingen av de tre visste om de andra.
 *
 * DET SPRACK DEN 20 SEPTEMBER. Nyckeln lades in i driften av ett skäl som inte hade med lagring att
 * göra — adminpanelen skulle kunna läsa säljarens adress ur Auth — och i samma sekund bytte alla tre
 * golv. Tabellerna fanns inte i projektet, butikens uppslag vid uppstart kastade, och servern gick i
 * kraschloop tills nyckeln togs bort igen. Loopa.nu svarade 502 i fyra minuter på en rad som ingen
 * trodde rörde butiken.
 *
 * EN NYCKEL ÄR EN BEHÖRIGHET, INTE ETT BESLUT. Att få läsa någonting är inte samma sak som att vilja
 * lägga allt där. Nu krävs ett uttryckligt `LOOPA_LAGRING=supabase` för flytten, och nyckeln säger
 * bara vad servern får göra när den väl är där.
 *
 * FÖRVALET ÄR FILER, även när nyckeln finns. Det är den säkra riktningen: filryggen är där data
 * ligger i dag, medan en tyst flytt till en tom eller saknad tabell antingen döljer allt som finns
 * eller fäller servern. En flytt ska kosta ett medvetet beslut och en migrering — aldrig bara en rad
 * i en miljöfil.
 */
export function supabaseLagring(): boolean {
  if (process.env.LOOPA_LAGRING?.trim().toLowerCase() !== "supabase") return false;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    /**
     * Valt men omöjligt, och det sägs vid uppstart i stället för vid första frågan.
     *
     * Tyst filrygg hade varit att svara på en beställning med något annat än det som beställdes —
     * och den som beställt Postgres hade upptäckt det först när data saknades.
     */
    console.warn("[lagring] LOOPA_LAGRING=supabase men SUPABASE_SERVICE_ROLE_KEY saknas — kör filryggen.");
    return false;
  }
  return true;
}
