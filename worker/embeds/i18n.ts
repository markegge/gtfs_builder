// ─── Embed UI-string localization ────────────────────────────────────────────
//
// Translates the embed *chrome* (banners, section headings, accessibility
// labels) into the requested language. The rider-facing GTFS *content* —
// route_long_name, stop_name, trip_headsign — is rendered verbatim from the
// published snapshot.
//
// IMPORTANT (see #34 i18n note): honoring GTFS `translations.txt` to localize
// that content is NOT possible today because the editor data model has no
// `translations` slice and the published snapshot JSON never carries one (see
// src/db/serverPersistence.ts DATA_KEYS — there is no `translations` key, and
// gtfsExport.ts never writes translations.txt). When a `translations` model
// field is added, look it up here per (table_name, field_name, record_id, lang)
// and translateContent() below becomes a real lookup instead of a passthrough.
//
// Language is resolved (highest precedence first) from:
//   1. the `lang` query param on the embed URL (BCP-47 primary subtag)
//   2. the feed's feed_info.feed_lang
//   3. the agency's agency_lang
//   4. 'en'
// We only switch the chrome when we actually have a dictionary for the language;
// otherwise we serve English so labels never go blank.

export type EmbedLang = 'en' | 'es' | 'fr' | 'de' | 'pt';

const SUPPORTED: readonly EmbedLang[] = ['en', 'es', 'fr', 'de', 'pt'];

export interface EmbedStrings {
  systemMap: string;
  routes: string;
  // Visible label of the back link to the system map on route/stop embeds.
  allRoutes: string;
  routesServingStop: string;
  departuresToday: (day: string) => string;
  noMoreDepartures: string;
  noServicePatterns: string;
  noTripsScheduled: string;
  todayIs: (day: string) => string;
  noServiceToday: string;
  scheduleInEffect: (label: string) => string;
  scheduleExpired: (days: number) => string;
  scheduleExpiresIn: (days: number, date: string) => string;
  serviceDay: string;
  stopIdLabel: string;
  routeCount: (n: number) => string;
  wheelchairAccessible: string;
  notWheelchairAccessible: string;
  poweredBy: string;
  loadingMap: string;
  // RT (live) strings.
  liveLabel: string;
  scheduledLabel: string;
  // Day names, Sunday-first to match getUTCDay()/dayOfWeekInTimezone().
  dayNames: readonly string[];
}

const EN: EmbedStrings = {
  systemMap: 'System map',
  routes: 'Routes',
  allRoutes: 'All routes',
  routesServingStop: 'Routes that serve this stop',
  departuresToday: (day) => `Departures today (${day})`,
  noMoreDepartures: 'No more departures today from this stop.',
  noServicePatterns: 'No service patterns defined.',
  noTripsScheduled: 'No trips scheduled for this service period.',
  todayIs: (day) => `Today is ${day}`,
  noServiceToday: 'No service today',
  scheduleInEffect: (label) => `${label} schedule in effect`,
  scheduleExpired: (days) => `Schedule expired ${days} day${days === 1 ? '' : 's'} ago.`,
  scheduleExpiresIn: (days, date) => `Schedule expires in ${days} day${days === 1 ? '' : 's'} (${date}).`,
  serviceDay: 'Service day',
  stopIdLabel: 'Stop ID',
  routeCount: (n) => `${n} route${n === 1 ? '' : 's'}`,
  wheelchairAccessible: 'Wheelchair accessible',
  notWheelchairAccessible: 'Not wheelchair accessible',
  poweredBy: 'Powered by',
  loadingMap: 'Loading map…',
  liveLabel: 'Live',
  scheduledLabel: 'Scheduled',
  dayNames: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};

const ES: EmbedStrings = {
  systemMap: 'Mapa del sistema',
  routes: 'Rutas',
  allRoutes: 'Todas las rutas',
  routesServingStop: 'Rutas que pasan por esta parada',
  departuresToday: (day) => `Salidas de hoy (${day})`,
  noMoreDepartures: 'No hay más salidas hoy desde esta parada.',
  noServicePatterns: 'No hay patrones de servicio definidos.',
  noTripsScheduled: 'No hay viajes programados para este periodo de servicio.',
  todayIs: (day) => `Hoy es ${day}`,
  noServiceToday: 'Sin servicio hoy',
  scheduleInEffect: (label) => `Horario ${label} en vigor`,
  scheduleExpired: (days) => `El horario venció hace ${days} día${days === 1 ? '' : 's'}.`,
  scheduleExpiresIn: (days, date) => `El horario vence en ${days} día${days === 1 ? '' : 's'} (${date}).`,
  serviceDay: 'Día de servicio',
  stopIdLabel: 'ID de parada',
  routeCount: (n) => `${n} ruta${n === 1 ? '' : 's'}`,
  wheelchairAccessible: 'Accesible para sillas de ruedas',
  notWheelchairAccessible: 'No accesible para sillas de ruedas',
  poweredBy: 'Desarrollado por',
  loadingMap: 'Cargando mapa…',
  liveLabel: 'En vivo',
  scheduledLabel: 'Programado',
  dayNames: ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'],
};

const FR: EmbedStrings = {
  systemMap: 'Plan du réseau',
  routes: 'Lignes',
  allRoutes: 'Toutes les lignes',
  routesServingStop: 'Lignes desservant cet arrêt',
  departuresToday: (day) => `Départs aujourd’hui (${day})`,
  noMoreDepartures: 'Plus de départs aujourd’hui à cet arrêt.',
  noServicePatterns: 'Aucun service défini.',
  noTripsScheduled: 'Aucun trajet prévu pour cette période de service.',
  todayIs: (day) => `Nous sommes ${day}`,
  noServiceToday: 'Pas de service aujourd’hui',
  scheduleInEffect: (label) => `Horaire ${label} en vigueur`,
  scheduleExpired: (days) => `Horaire expiré il y a ${days} jour${days === 1 ? '' : 's'}.`,
  scheduleExpiresIn: (days, date) => `Horaire expire dans ${days} jour${days === 1 ? '' : 's'} (${date}).`,
  serviceDay: 'Jour de service',
  stopIdLabel: 'Arrêt n°',
  routeCount: (n) => `${n} ligne${n === 1 ? '' : 's'}`,
  wheelchairAccessible: 'Accessible aux fauteuils roulants',
  notWheelchairAccessible: 'Non accessible aux fauteuils roulants',
  poweredBy: 'Propulsé par',
  loadingMap: 'Chargement de la carte…',
  liveLabel: 'En direct',
  scheduledLabel: 'Prévu',
  dayNames: ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'],
};

const DE: EmbedStrings = {
  systemMap: 'Liniennetzplan',
  routes: 'Linien',
  allRoutes: 'Alle Linien',
  routesServingStop: 'Linien an dieser Haltestelle',
  departuresToday: (day) => `Abfahrten heute (${day})`,
  noMoreDepartures: 'Heute keine weiteren Abfahrten an dieser Haltestelle.',
  noServicePatterns: 'Keine Fahrpläne definiert.',
  noTripsScheduled: 'Keine Fahrten für diesen Servicezeitraum geplant.',
  todayIs: (day) => `Heute ist ${day}`,
  noServiceToday: 'Heute kein Service',
  scheduleInEffect: (label) => `Fahrplan ${label} in Kraft`,
  scheduleExpired: (days) => `Fahrplan vor ${days} Tag${days === 1 ? '' : 'en'} abgelaufen.`,
  scheduleExpiresIn: (days, date) => `Fahrplan läuft in ${days} Tag${days === 1 ? '' : 'en'} ab (${date}).`,
  serviceDay: 'Verkehrstag',
  stopIdLabel: 'Haltestellen-ID',
  routeCount: (n) => `${n} Linie${n === 1 ? '' : 'n'}`,
  wheelchairAccessible: 'Rollstuhlgerecht',
  notWheelchairAccessible: 'Nicht rollstuhlgerecht',
  poweredBy: 'Bereitgestellt von',
  loadingMap: 'Karte wird geladen…',
  liveLabel: 'Live',
  scheduledLabel: 'Planmäßig',
  dayNames: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'],
};

const PT: EmbedStrings = {
  systemMap: 'Mapa do sistema',
  routes: 'Linhas',
  allRoutes: 'Todas as linhas',
  routesServingStop: 'Linhas que servem esta parada',
  departuresToday: (day) => `Partidas de hoje (${day})`,
  noMoreDepartures: 'Não há mais partidas hoje desta parada.',
  noServicePatterns: 'Nenhum padrão de serviço definido.',
  noTripsScheduled: 'Nenhuma viagem programada para este período de serviço.',
  todayIs: (day) => `Hoje é ${day}`,
  noServiceToday: 'Sem serviço hoje',
  scheduleInEffect: (label) => `Horário ${label} em vigor`,
  scheduleExpired: (days) => `O horário expirou há ${days} dia${days === 1 ? '' : 's'}.`,
  scheduleExpiresIn: (days, date) => `O horário expira em ${days} dia${days === 1 ? '' : 's'} (${date}).`,
  serviceDay: 'Dia de serviço',
  stopIdLabel: 'ID da parada',
  routeCount: (n) => `${n} linha${n === 1 ? '' : 's'}`,
  wheelchairAccessible: 'Acessível para cadeira de rodas',
  notWheelchairAccessible: 'Não acessível para cadeira de rodas',
  poweredBy: 'Desenvolvido por',
  loadingMap: 'Carregando mapa…',
  liveLabel: 'Ao vivo',
  scheduledLabel: 'Programado',
  dayNames: ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'],
};

const DICTIONARIES: Record<EmbedLang, EmbedStrings> = { en: EN, es: ES, fr: FR, de: DE, pt: PT };

/** Normalize a raw BCP-47 / GTFS language code to a supported primary subtag, or null. */
export function normalizeLang(raw: string | null | undefined): EmbedLang | null {
  if (!raw) return null;
  const primary = raw.trim().toLowerCase().split(/[-_]/)[0];
  return (SUPPORTED as readonly string[]).includes(primary) ? (primary as EmbedLang) : null;
}

/**
 * Resolve the effective embed language from the request param + feed defaults.
 * Returns both the normalized code (always one of SUPPORTED, defaulting to
 * 'en') and the dictionary for it. `paramLang` wins; then feed_lang;
 * then agency_lang; then 'en'.
 */
export function resolveLang(
  paramLang: string | null | undefined,
  feedLang: string | null | undefined,
  agencyLang: string | null | undefined,
): { lang: EmbedLang; t: EmbedStrings } {
  const lang =
    normalizeLang(paramLang) ?? normalizeLang(feedLang) ?? normalizeLang(agencyLang) ?? 'en';
  return { lang, t: DICTIONARIES[lang] };
}

export function isSupportedLang(code: string): code is EmbedLang {
  return (SUPPORTED as readonly string[]).includes(code);
}

export { SUPPORTED as SUPPORTED_LANGS };
