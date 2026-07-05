const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

const BRUSSELS = [50.8467, 4.3525];
const MAX_GEOCODE_RESULTS = 1;
const addressSelections = new Map();
const searchTimers = new Map();

let map;
let routeLayer;
let markerLayer;
let poiLayer;
let baseTileLayer;
let weatherLayer;
let currentRouteLine = [];
let currentRouteDistance = 0;
let currentDestinationLabel = "";
let guidanceWatchId = null;
let guidanceDemoTimer = null;
let guidanceDemoIndex = 0;

function updatePreference(label) {
  label.classList.toggle("active", label.querySelector("input").checked);
}

function showToast(title, message) {
  $("#toast").innerHTML = `<b>${escapeHtml(title)}</b><span>${escapeHtml(message)}</span>`;
  $("#toast").classList.add("show");
  setTimeout(() => $("#toast").classList.remove("show"), 3000);
}

function setLoading(isLoading) {
  const button = $(".calculate-button");
  button.disabled = isLoading;
  button.querySelector("span").textContent = isLoading ? "Calcul en cours..." : "Calculer l'itinéraire";
}

function setStatus(message) {
  $("#mapStatus").textContent = message;
}

window.addEventListener("error", (event) => {
  setStatus("Une erreur d'affichage est survenue. Rechargez la page ou réessayez le calcul.");
  console.error(event.error || event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  setStatus("Le service de carte ou d'itinéraire n'a pas répondu. Réessayez dans quelques secondes.");
  console.error(event.reason);
});

function formatKm(meters) {
  return (meters / 1000).toLocaleString("fr-BE", { maximumFractionDigits: 1 });
}

function formatMeters(meters) {
  if (meters >= 1000) return `${(meters / 1000).toLocaleString("fr-BE", { maximumFractionDigits: 1 })} km`;
  return `${Math.max(0, Math.round(meters))} m`;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[char]);
}

function addressLabel(properties) {
  return [
    properties.name,
    properties.street,
    properties.housenumber,
    properties.city || properties.locality || properties.district,
    properties.country
  ].filter(Boolean).join(", ");
}

function addressSubtitle(properties) {
  return [
    properties.postcode,
    properties.city || properties.locality || properties.district,
    properties.state
  ].filter(Boolean).join(" · ");
}

function clearSuggestions(list) {
  list.innerHTML = "";
  list.classList.remove("open");
}

function renderSuggestions(input, list, results) {
  list.innerHTML = "";

  if (!results.length) {
    clearSuggestions(list);
    return;
  }

  results.forEach((result) => {
    const properties = result.properties;
    const label = addressLabel(properties);
    const subtitle = addressSubtitle(properties);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggestion-item";
    button.innerHTML = `<b>${escapeHtml(label)}</b><small>${escapeHtml(subtitle || "Adresse OpenStreetMap")}</small>`;
    button.addEventListener("click", () => {
      input.value = label;
      addressSelections.set(input.id, {
        label,
        lat: result.geometry.coordinates[1],
        lon: result.geometry.coordinates[0]
      });
      clearSuggestions(list);
      setStatus(`Adresse sélectionnée : ${label}`);
    });
    list.appendChild(button);
  });

  list.classList.add("open");
}

async function searchAddresses(query) {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "6");
  url.searchParams.set("lang", "fr");
  url.searchParams.set("lat", BRUSSELS[0]);
  url.searchParams.set("lon", BRUSSELS[1]);

  const response = await fetch(url.toString(), { headers: { "Accept": "application/json" } });
  if (!response.ok) throw new Error("La recherche d'adresses n'a pas répondu.");
  const data = await response.json();
  return (data.features || []).filter((feature) => feature.geometry?.coordinates?.length === 2);
}

function setupAddressSearch(inputSelector, listSelector) {
  const input = $(inputSelector);
  const list = $(listSelector);

  input.addEventListener("input", () => {
    addressSelections.delete(input.id);
    const query = input.value.trim();
    clearTimeout(searchTimers.get(input.id));

    if (query.length < 3) {
      clearSuggestions(list);
      return;
    }

    searchTimers.set(input.id, setTimeout(async () => {
      try {
        const results = await searchAddresses(query);
        renderSuggestions(input, list, results);
      } catch (error) {
        clearSuggestions(list);
      }
    }, 280));
  });

  input.addEventListener("focus", () => {
    if (list.children.length) list.classList.add("open");
  });
}

function estimateBattery(distanceMeters, durationSeconds) {
  const km = distanceMeters / 1000;
  const movingMinutes = durationSeconds / 60;
  const slopePrefSaving = $("#slopePref").checked ? -2 : 0;
  const safetyCost = $("#safePref").checked ? 1 : 0;
  return Math.max(6, Math.round(km * 2.3 + movingMinutes * 0.12 + safetyCost + slopePrefSaving));
}

function estimateScore(distanceMeters, durationSeconds) {
  const speedKmh = distanceMeters / 1000 / (durationSeconds / 3600);
  let score = 82;
  if ($("#safePref").checked) score += 8;
  if ($("#bikePref").checked) score += 6;
  if ($("#slopePref").checked) score += 3;
  if (speedKmh > 22) score -= 5;
  if (distanceMeters > 10000) score -= 4;
  return Math.max(55, Math.min(98, Math.round(score)));
}

function scooterSpeedKmh(weather) {
  let speed = 16;
  if ($("#safePref").checked) speed -= 1.2;
  if ($("#slopePref").checked) speed -= 0.8;
  if (weather?.severity === "medium") speed -= 1.5;
  if (weather?.severity === "high") speed -= 3.5;
  return Math.max(10, Math.min(20, speed));
}

function estimateScooterDuration(distanceMeters, weather) {
  const km = distanceMeters / 1000;
  const movingSeconds = km / scooterSpeedKmh(weather) * 3600;
  const intersectionDelay = Math.max(90, Math.round(km * 75));
  const parkingDelay = 45;
  return Math.round(movingSeconds + intersectionDelay + parkingDelay);
}

function routeDetails(distanceMeters, durationSeconds, weather) {
  const protectedRatio = $("#bikePref").checked ? "priorité au réseau cyclable" : "profil vélo standard";
  const terrain = $("#slopePref").checked ? "pente limitée quand possible" : "relief non optimisé";
  const fallbackWarning = distanceMeters > 8000 ? "Long trajet : prévoyez une marge batterie" : "Vérifiez les zones locales interdites aux trottinettes";
  const weatherClass = weather?.severity === "high" ? "weather-danger" : weather?.severity === "medium" ? "weather-alert" : "weather-clear";
  const weatherIcon = weather?.severity === "low" ? "✓" : "!";
  const weatherMessage = weather?.message || fallbackWarning;

  $(".route-details").innerHTML = `
    <span><i class="green-check">✓</i> ${protectedRatio}</span>
    <span><i class="green-check">✓</i> ${terrain}</span>
    <span class="warning-text ${weatherClass}"><i>${weatherIcon}</i> ${weatherMessage}</span>
  `;
}

function initMap() {
  if (!window.L) {
    setStatus("La carte réelle n'a pas pu se charger. Vérifiez votre connexion Internet.");
    return;
  }

  map = L.map("realMap", {
    zoomControl: false,
    attributionControl: false
  }).setView(BRUSSELS, 13);

  installBaseMap(0);

  routeLayer = L.layerGroup().addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  poiLayer = L.layerGroup().addTo(map);
  weatherLayer = L.layerGroup().addTo(map);

  setTimeout(() => map.invalidateSize(), 250);
  window.addEventListener("resize", () => map.invalidateSize());
}

function installBaseMap(sourceIndex) {
  const sources = [
    {
      url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      options: { subdomains: "abcd", maxZoom: 20, attribution: "© OpenStreetMap © CARTO" }
    },
    {
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      options: { maxZoom: 19, attribution: "© OpenStreetMap" }
    },
    {
      url: "https://tile.openstreetmap.de/{z}/{x}/{y}.png",
      options: { maxZoom: 19, attribution: "© OpenStreetMap" }
    }
  ];

  const source = sources[sourceIndex];
  let tileErrors = 0;

  if (baseTileLayer) map.removeLayer(baseTileLayer);
  baseTileLayer = L.tileLayer(source.url, {
    ...source.options,
    crossOrigin: true,
    errorTileUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='256' height='256' viewBox='0 0 256 256'%3E%3Crect width='256' height='256' fill='%23eff0e8'/%3E%3Cpath d='M0 64h256M0 128h256M0 192h256M64 0v256M128 0v256M192 0v256' stroke='%23d8dcd2' stroke-width='2'/%3E%3C/svg%3E"
  });

  baseTileLayer.on("tileload", () => {
    $("#realMap").classList.add("tiles-loaded");
  });

  baseTileLayer.on("tileerror", () => {
    tileErrors += 1;
    if (tileErrors === 5 && sourceIndex < sources.length - 1) {
      setStatus("Le fond de carte principal charge mal, bascule vers un fond alternatif...");
      installBaseMap(sourceIndex + 1);
    }
    if (tileErrors === 5 && sourceIndex === sources.length - 1) {
      setStatus("Fond de carte partiel : l'itinéraire reste utilisable, mais certaines tuiles n'ont pas chargé.");
    }
  });

  baseTileLayer.addTo(map);
}

function markerIcon(className, label) {
  return L.divIcon({
    className: `volt-marker ${className}`,
    html: `<span>${label}</span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17]
  });
}

function addPoi(center) {
  poiLayer.clearLayers();
  const lat = Array.isArray(center) ? center[0] : center.lat;
  const lng = Array.isArray(center) ? center[1] : center.lng;
  const pois = [
    { type: "charge", label: "⚡", title: "Point de recharge proche", coords: [lat + 0.006, lng - 0.008] },
    { type: "parking", label: "P", title: "Parking trottinette", coords: [lat - 0.005, lng + 0.009] },
    { type: "warning", label: "!", title: "Zone à vérifier avant départ", coords: [lat + 0.002, lng + 0.012] }
  ];

  pois.forEach((poi) => {
    L.marker(poi.coords, { icon: markerIcon(poi.type, poi.label), poiType: poi.type })
      .bindPopup(poi.title)
      .addTo(poiLayer);
  });
}

async function geocode(query) {
  const normalized = query.toLowerCase().includes("bruxelles") || query.toLowerCase().includes("brussels")
    ? query
    : `${query}, Bruxelles, Belgique`;
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", MAX_GEOCODE_RESULTS);
  url.searchParams.set("accept-language", "fr");
  url.searchParams.set("countrycodes", "be");
  url.searchParams.set("q", normalized);

  const response = await fetch(url.toString(), {
    headers: { "Accept": "application/json" }
  });
  if (!response.ok) throw new Error("Le géocodage n'a pas répondu.");
  const results = await response.json();
  if (!results.length) throw new Error(`Adresse introuvable : ${query}`);
  return {
    label: results[0].display_name,
    lat: Number(results[0].lat),
    lon: Number(results[0].lon)
  };
}

async function resolveAddress(inputId) {
  const selected = addressSelections.get(inputId);
  if (selected) return selected;
  return geocode($(`#${inputId}`).value.trim());
}

async function fetchRoute(start, end) {
  const request = {
    locations: [
      { lat: start.lat, lon: start.lon, type: "break" },
      { lat: end.lat, lon: end.lon, type: "break" }
    ],
    costing: "bicycle",
    costing_options: {
      bicycle: {
        bicycle_type: "Hybrid",
        use_roads: $("#safePref").checked ? 0.25 : 0.45,
        use_hills: $("#slopePref").checked ? 0.15 : 0.35
      }
    },
    directions_options: { units: "kilometers", language: "fr-FR" },
    shape_format: "geojson"
  };
  const url = `https://valhalla1.openstreetmap.de/route?json=${encodeURIComponent(JSON.stringify(request))}`;
  const response = await fetch(url, {
    headers: { "Accept": "application/json" }
  });
  if (!response.ok) throw new Error("Le moteur d'itinéraire n'a pas répondu.");
  const data = await response.json();
  if (!data.trip?.summary || !data.trip?.legs?.length) throw new Error("Aucun itinéraire réel trouvé.");
  return {
    distance: data.trip.summary.length * 1000,
    duration: data.trip.summary.time,
    line: normalizeRouteLine(data.trip.legs[0].shape),
    source: "Valhalla / OpenStreetMap"
  };
}

function weatherCodeMeansWet(code) {
  return [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(Number(code));
}

function routeCenter(line) {
  return line[Math.floor(line.length / 2)] || BRUSSELS;
}

function distanceBetween(a, b) {
  const radius = 6371000;
  const lat1 = a[0] * Math.PI / 180;
  const lat2 = b[0] * Math.PI / 180;
  const deltaLat = (b[0] - a[0]) * Math.PI / 180;
  const deltaLng = (b[1] - a[1]) * Math.PI / 180;
  const sinLat = Math.sin(deltaLat / 2);
  const sinLng = Math.sin(deltaLng / 2);
  const value = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * radius * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function bearingBetween(a, b) {
  const lat1 = a[0] * Math.PI / 180;
  const lat2 = b[0] * Math.PI / 180;
  const deltaLng = (b[1] - a[1]) * Math.PI / 180;
  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function nearestRouteIndex(position, line) {
  let nearestIndex = 0;
  let nearestDistance = Infinity;
  line.forEach((point, index) => {
    const distance = distanceBetween(position, point);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });
  return nearestIndex;
}

function remainingDistanceFrom(index, line) {
  let total = 0;
  for (let i = Math.max(0, index); i < line.length - 1; i += 1) {
    total += distanceBetween(line[i], line[i + 1]);
  }
  return total;
}

async function fetchWeatherForRoute(line) {
  const [lat, lng] = routeCenter(line);
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat.toFixed(5));
  url.searchParams.set("longitude", lng.toFixed(5));
  url.searchParams.set("current", "temperature_2m,precipitation,rain,showers,weather_code,wind_speed_10m");
  url.searchParams.set("hourly", "precipitation_probability,precipitation,rain,showers");
  url.searchParams.set("forecast_hours", "3");
  url.searchParams.set("timezone", "auto");

  const response = await fetch(url.toString(), { headers: { "Accept": "application/json" } });
  if (!response.ok) throw new Error("La météo n'a pas répondu.");
  const data = await response.json();
  return analyzeWeather(data);
}

function maxFrom(values = []) {
  return Math.max(0, ...values.filter((value) => Number.isFinite(Number(value))).map(Number));
}

function analyzeWeather(data) {
  const current = data.current || {};
  const hourly = data.hourly || {};
  const rainNow = Math.max(
    Number(current.precipitation || 0),
    Number(current.rain || 0),
    Number(current.showers || 0)
  );
  const rainSoon = Math.max(
    maxFrom(hourly.precipitation),
    maxFrom(hourly.rain),
    maxFrom(hourly.showers)
  );
  const probability = maxFrom(hourly.precipitation_probability);
  const wind = Number(current.wind_speed_10m || 0);
  const codeIsWet = weatherCodeMeansWet(current.weather_code);
  const rain = Math.max(rainNow, rainSoon);

  if (rain >= 0.7 || probability >= 65 || codeIsWet) {
    return {
      severity: "high",
      message: `Pluie détectée : route glissante probable (${rain.toFixed(1)} mm, ${probability}% de risque).`,
      rain,
      wind
    };
  }

  if (rain > 0 || probability >= 35 || wind >= 35) {
    const reason = wind >= 35 ? `vent fort ${Math.round(wind)} km/h` : `${probability}% de risque de pluie`;
    return {
      severity: "medium",
      message: `Prudence météo : ${reason}, adhérence à surveiller.`,
      rain,
      wind
    };
  }

  return {
    severity: "low",
    message: `Météo OK : pas de pluie prévue sur le trajet, vent ${Math.round(wind)} km/h.`,
    rain,
    wind
  };
}

function normalizeRouteLine(shape) {
  let line = [];

  if (typeof shape === "string") {
    line = decodeValhallaShape(shape);
  } else if (shape?.type === "LineString" && Array.isArray(shape.coordinates)) {
    line = shape.coordinates.map(([lng, lat]) => [lat, lng]);
  } else if (Array.isArray(shape)) {
    line = shape.map(([lng, lat]) => [lat, lng]);
  }

  const cleanLine = line
    .map(([lat, lng]) => [Number(lat), Number(lng)])
    .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));

  if (!cleanLine.length) return [];

  const [firstLat, firstLng] = cleanLine[0];
  const looksSwapped = Math.abs(firstLat) < 15 && Math.abs(firstLng) > 35;
  const normalized = looksSwapped ? cleanLine.map(([lat, lng]) => [lng, lat]) : cleanLine;

  return normalized.filter(([lat, lng]) => lat > -90 && lat < 90 && lng > -180 && lng < 180);
}

function decodeValhallaShape(shape) {
  let index = 0;
  let lat = 0;
  let lng = 0;
  const coordinates = [];

  while (index < shape.length) {
    let result = 1;
    let shift = 0;
    let byte = null;
    do {
      byte = shape.charCodeAt(index++) - 63 - 1;
      result += byte << shift;
      shift += 5;
    } while (byte >= 0x1f);
    lat += (result & 1) ? ~(result >> 1) : result >> 1;

    result = 1;
    shift = 0;
    do {
      byte = shape.charCodeAt(index++) - 63 - 1;
      result += byte << shift;
      shift += 5;
    } while (byte >= 0x1f);
    lng += (result & 1) ? ~(result >> 1) : result >> 1;

    coordinates.push([lat / 1e6, lng / 1e6]);
  }

  return coordinates;
}

function renderWeatherOnMap(line, weather) {
  weatherLayer.clearLayers();
  if (!weather || weather.severity === "low") return;

  const color = weather.severity === "high" ? "#d84b31" : "#e98143";
  L.polyline(line, {
    color,
    weight: 9,
    opacity: 0.82,
    dashArray: "8 12"
  }).addTo(weatherLayer);

  L.marker(routeCenter(line), { icon: markerIcon("weather", weather.severity === "high" ? "☔" : "!") })
    .bindPopup(weather.message)
    .addTo(weatherLayer);
}

function updateGuidanceScreen({ position, speed = 0, heading = null, mode = "GPS actif" }) {
  if (!currentRouteLine.length) {
    $("#guidanceNote").textContent = "Calculez un itinéraire avant de lancer le guidage.";
    showToast("Guidage indisponible", "Calculez d'abord un itinéraire.");
    return;
  }

  const nearestIndex = nearestRouteIndex(position, currentRouteLine);
  const targetIndex = Math.min(currentRouteLine.length - 1, nearestIndex + 4);
  const nextPoint = currentRouteLine[targetIndex];
  const routeBearing = bearingBetween(position, nextPoint);
  const activeBearing = Number.isFinite(heading) && speed > 1.5 ? heading : routeBearing;
  const nextDistance = distanceBetween(position, nextPoint);
  const remaining = remainingDistanceFrom(nearestIndex, currentRouteLine);
  const turnLabel = Math.abs(((routeBearing - activeBearing + 540) % 360) - 180) < 25
    ? "Continuez tout droit"
    : ((routeBearing - activeBearing + 360) % 360) > 180
      ? "Gardez la gauche"
      : "Gardez la droite";

  $("#navWorld").style.transform = `rotate(${-activeBearing}deg)`;
  $("#navCompass").style.transform = `translate(-50%, -50%) rotate(${activeBearing}deg)`;
  $("#guidanceMode").textContent = mode;
  $("#guidanceSpeed").textContent = `${Math.max(0, Math.round(speed * 3.6))} km/h`;
  $("#maneuverDistance").textContent = formatMeters(nextDistance);
  $("#maneuverText").textContent = `${turnLabel} vers ${currentDestinationLabel || "la destination"}`;
  $("#bearingText").textContent = `Cap navigation : ${Math.round(activeBearing)}° · reste ${formatMeters(remaining)}`;
  $("#guidanceNote").textContent = "Affichage orienté dans le sens de déplacement : la flèche reste vers le haut.";
}

function stopGuidance() {
  if (guidanceWatchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(guidanceWatchId);
  }
  guidanceWatchId = null;
  clearInterval(guidanceDemoTimer);
  guidanceDemoTimer = null;
}

function startGuidanceFromPlanner() {
  openGuidancePage("active");
}

function startActiveGuidance() {
  openGuidancePage("active");
}

function openGuidancePage(mode) {
  if (!currentRouteLine.length && !localStorage.getItem("voltwayGuidanceRoute")) {
    showToast("Guidage indisponible", "Calculez d'abord un itinéraire.");
    return;
  }
  window.location.href = `guidance.html?mode=${mode}`;
}

function updateGuidancePreview(line, distanceMeters) {
  if (!line.length) return;

  const lats = line.map((point) => point[0]);
  const lngs = line.map((point) => point[1]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latSpan = Math.max(0.0001, maxLat - minLat);
  const lngSpan = Math.max(0.0001, maxLng - minLng);
  const points = line.filter((_, index) => index % Math.max(1, Math.floor(line.length / 28)) === 0);
  const projected = points.map(([lat, lng]) => {
    const x = 38 + ((lng - minLng) / lngSpan) * 244;
    const y = 392 - ((lat - minLat) / latSpan) * 360;
    return [x, y];
  });
  const d = projected.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  $("#navRoutePath").setAttribute("d", d);
  $("#maneuverDistance").textContent = formatMeters(distanceMeters);
  $("#maneuverText").textContent = `Prêt vers ${currentDestinationLabel || "la destination"}`;
  $("#bearingText").textContent = "Le guidage orientera la vue au démarrage.";
}

function renderRoute(start, end, route, weather) {
  const line = route.line;
  if (!line.length) throw new Error("Le moteur a renvoyé un tracé vide.");
  const scooterDuration = estimateScooterDuration(route.distance, weather);
  const durationMinutes = Math.max(1, Math.round(scooterDuration / 60));
  const weatherBatteryCost = weather?.severity === "high" ? 3 : weather?.severity === "medium" ? 1 : 0;
  const weatherScorePenalty = weather?.severity === "high" ? 12 : weather?.severity === "medium" ? 6 : 0;
  const battery = estimateBattery(route.distance, scooterDuration) + weatherBatteryCost;
  const score = Math.max(35, estimateScore(route.distance, scooterDuration) - weatherScorePenalty);
  const arrival = new Date(Date.now() + scooterDuration * 1000).toLocaleTimeString("fr-BE", {
    hour: "2-digit",
    minute: "2-digit"
  });

  map.invalidateSize();
  routeLayer.clearLayers();
  markerLayer.clearLayers();
  weatherLayer.clearLayers();

  L.polyline(line, { color: "#ffffff", weight: 12, opacity: 0.9 }).addTo(routeLayer);
  L.polyline(line, { color: "#21694b", weight: 6, opacity: 0.98 }).addTo(routeLayer);
  L.marker([start.lat, start.lon], { icon: markerIcon("start", "•") }).bindPopup(`Départ<br>${escapeHtml(start.label)}`).addTo(markerLayer);
  L.marker([end.lat, end.lon], { icon: markerIcon("end", "⌂") }).bindPopup(`Destination<br>${escapeHtml(end.label)}`).addTo(markerLayer);

  const bounds = L.latLngBounds(line);
  if (!bounds.isValid()) throw new Error("Le tracé reçu n'est pas exploitable.");
  map.fitBounds(bounds.pad(0.22), { animate: true, maxZoom: 16 });
  addPoi(bounds.getCenter());
  renderWeatherOnMap(line, weather);

  $("#duration").textContent = durationMinutes;
  $("#distance").textContent = formatKm(route.distance);
  $("#battery").textContent = battery;
  $("#score").textContent = score;
  $("#arrival").textContent = `Arrivée à ${arrival}`;
  routeDetails(route.distance, scooterDuration, weather);
  setStatus(`Temps estimé à ${scooterSpeedKmh(weather).toFixed(1).replace(".", ",")} km/h de moyenne trottinette. ${weather?.message || "Météo non disponible."}`);
  currentRouteLine = line;
  currentRouteDistance = route.distance;
  currentDestinationLabel = end.label.split(",").slice(0, 2).join(", ");
  localStorage.setItem("voltwayGuidanceRoute", JSON.stringify({
    line,
    distance: route.distance,
    duration: scooterDuration,
    averageSpeedKmh: scooterSpeedKmh(weather),
    destination: currentDestinationLabel,
    weather: weather?.message || "Météo non disponible",
    savedAt: new Date().toISOString()
  }));
}

async function calculateRoute() {
  if (!map) {
    showToast("Carte indisponible", "Impossible de charger la carte réelle.");
    return;
  }

  setLoading(true);
  setStatus("Recherche des adresses...");

  try {
    const [start, end] = await Promise.all([
      resolveAddress("startInput"),
      resolveAddress("endInput")
    ]);

    setStatus("Calcul d'un itinéraire réel avec profil vélo/trottinette...");
    const route = await fetchRoute(start, end);
    setStatus("Analyse de la météo sur l'itinéraire...");
    let weather = null;
    try {
      weather = await fetchWeatherForRoute(route.line);
    } catch (weatherError) {
      weather = {
        severity: "medium",
        message: "Météo indisponible : vérifiez la pluie avant de partir.",
        rain: 0,
        wind: 0
      };
    }
    renderRoute(start, end, route, weather);
    showToast("Itinéraire calculé", weather.message);
  } catch (error) {
    const message = error.message || "Le calcul n'a pas abouti.";
    setStatus(message);
    showToast("Calcul impossible", message);
  } finally {
    setLoading(false);
  }
}

$$(".pref input").forEach((input) => input.addEventListener("change", () => updatePreference(input.closest(".pref"))));

$("#resetPrefs").addEventListener("click", () => {
  $$(".pref input").forEach((input, index) => {
    input.checked = index < 2;
    updatePreference(input.closest(".pref"));
  });
});

$("#swapButton").addEventListener("click", () => {
  const start = $("#startInput");
  const end = $("#endInput");
  [start.value, end.value] = [end.value, start.value];
  const startSelection = addressSelections.get("startInput");
  const endSelection = addressSelections.get("endInput");
  if (endSelection) addressSelections.set("startInput", endSelection);
  else addressSelections.delete("startInput");
  if (startSelection) addressSelections.set("endInput", startSelection);
  else addressSelections.delete("endInput");
});

$("#routeForm").addEventListener("submit", (event) => {
  event.preventDefault();
  calculateRoute();
});

$$(".map-chips button").forEach((button) => button.addEventListener("click", () => {
  $$(".map-chips button").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");

  if (!poiLayer) return;
  const filter = button.dataset.layer;
  poiLayer.eachLayer((layer) => {
    const type = layer.options.poiType;
    const visible = filter === "all" || type === filter;
    layer.getElement()?.classList.toggle("hidden-poi", !visible);
  });
}));

$("#themeButton").addEventListener("click", () => document.body.classList.toggle("dark"));
$("#startGuidanceButton").addEventListener("click", startActiveGuidance);

document.addEventListener("click", (event) => {
  if (!event.target.closest(".address-field")) {
    $$(".suggestions").forEach(clearSuggestions);
  }
});

const zoomButtons = $$(".map-controls button");
zoomButtons[0].addEventListener("click", () => map?.zoomIn());
zoomButtons[1].addEventListener("click", () => map?.zoomOut());

initMap();
setupAddressSearch("#startInput", "#startSuggestions");
setupAddressSearch("#endInput", "#endSuggestions");
setStatus("Choisissez une adresse suggérée ou cliquez sur Calculer l'itinéraire.");
