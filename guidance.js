const $ = (selector) => document.querySelector(selector);

let routeLine = [];
let routeDistance = 0;
let routeDuration = 0;
let averageSpeedKmh = 0;
let destinationLabel = "";
let watchId = null;
let guidanceSteps = [];

function showToast(title, message) {
  $("#toast").innerHTML = `<b>${escapeHtml(title)}</b><span>${escapeHtml(message)}</span>`;
  $("#toast").classList.add("show");
  setTimeout(() => $("#toast").classList.remove("show"), 3000);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[char]);
}

function formatMeters(meters) {
  if (meters >= 1000) return `${(meters / 1000).toLocaleString("fr-BE", { maximumFractionDigits: 1 })} km`;
  return `${Math.max(0, Math.round(meters))} m`;
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

function nearestRouteIndex(position) {
  let nearestIndex = 0;
  let nearestDistance = Infinity;
  routeLine.forEach((point, index) => {
    const distance = distanceBetween(position, point);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });
  return nearestIndex;
}

function remainingDistanceFrom(index) {
  let total = 0;
  for (let i = Math.max(0, index); i < routeLine.length - 1; i += 1) {
    total += distanceBetween(routeLine[i], routeLine[i + 1]);
  }
  return total;
}

function turnDelta(fromBearing, toBearing) {
  return ((toBearing - fromBearing + 540) % 360) - 180;
}

function instructionForDelta(delta) {
  const abs = Math.abs(delta);
  if (abs < 25) return { icon: "↑", text: "Continuez tout droit" };
  if (abs < 65) return delta > 0 ? { icon: "↱", text: "Tournez légèrement à droite" } : { icon: "↰", text: "Tournez légèrement à gauche" };
  if (abs < 135) return delta > 0 ? { icon: "→", text: "Tournez à droite" } : { icon: "←", text: "Tournez à gauche" };
  return { icon: "↺", text: "Faites demi-tour si possible" };
}

function buildGuidanceSteps() {
  guidanceSteps = [];
  if (routeLine.length < 2) return;

  let accumulated = 0;
  let segmentStartDistance = 0;
  let previousBearing = bearingBetween(routeLine[0], routeLine[1]);

  guidanceSteps.push({
    index: 0,
    distanceFromStart: 0,
    distance: 0,
    icon: "↑",
    text: `Démarrez vers ${destinationLabel || "la destination"}`
  });

  for (let index = 1; index < routeLine.length - 2; index += 1) {
    accumulated += distanceBetween(routeLine[index - 1], routeLine[index]);
    const nextBearing = bearingBetween(routeLine[index], routeLine[index + 1]);
    const delta = turnDelta(previousBearing, nextBearing);

    if (Math.abs(delta) >= 32 && accumulated - segmentStartDistance > 70) {
      const instruction = instructionForDelta(delta);
      guidanceSteps.push({
        index,
        distanceFromStart: accumulated,
        distance: accumulated - segmentStartDistance,
        icon: instruction.icon,
        text: instruction.text
      });
      segmentStartDistance = accumulated;
      previousBearing = nextBearing;
    }
  }

  const finalDistance = routeDistance || accumulated;
  guidanceSteps.push({
    index: routeLine.length - 1,
    distanceFromStart: finalDistance,
    distance: Math.max(0, finalDistance - segmentStartDistance),
    icon: "●",
    text: `Arrivée : ${destinationLabel || "destination"}`
  });
}

function activeStepIndex(routeIndex) {
  if (!guidanceSteps.length) return 0;
  let active = 0;
  guidanceSteps.forEach((step, index) => {
    if (routeIndex >= step.index) active = index;
  });
  return active;
}

function renderSteps(activeIndex = 0) {
  const list = $("#stepsList");
  const visibleSteps = guidanceSteps.slice(activeIndex, activeIndex + 5);

  if (!visibleSteps.length) {
    list.innerHTML = "<li>Aucune étape disponible.</li>";
    $("#stepsCount").textContent = "0 étape";
    return;
  }

  $("#stepsCount").textContent = `${guidanceSteps.length} étapes`;
  list.innerHTML = visibleSteps.map((step, index) => `
    <li class="${index === 0 ? "active" : ""}">
      <span class="step-icon">${step.icon}</span>
      <div>
        <b>${escapeHtml(step.text)}</b>
        <small>${index === 0 ? "Maintenant" : `Dans ${formatMeters(step.distance)}`}</small>
      </div>
    </li>
  `).join("");
}

function updateGuidancePreview() {
  if (!routeLine.length) return;

  const lats = routeLine.map((point) => point[0]);
  const lngs = routeLine.map((point) => point[1]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latSpan = Math.max(0.0001, maxLat - minLat);
  const lngSpan = Math.max(0.0001, maxLng - minLng);
  const step = Math.max(1, Math.floor(routeLine.length / 30));
  const points = routeLine.filter((_, index) => index % step === 0);
  const projected = points.map(([lat, lng]) => {
    const x = 38 + ((lng - minLng) / lngSpan) * 244;
    const y = 392 - ((lat - minLat) / latSpan) * 360;
    return [x, y];
  });
  const d = projected.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  $("#navRoutePath").setAttribute("d", d);
  $("#maneuverDistance").textContent = formatMeters(routeDistance);
  $("#maneuverText").textContent = `Prêt vers ${destinationLabel || "la destination"}`;
  const durationText = routeDuration ? ` · durée trottinette ${Math.round(routeDuration / 60)} min` : "";
  const speedText = averageSpeedKmh ? ` à ${averageSpeedKmh.toFixed(1).replace(".", ",")} km/h moyen` : "";
  $("#bearingText").textContent = `Le haut de l'écran suivra le cap${durationText}${speedText}.`;
}

function updateGuidanceScreen({ position, speed = 0, heading = null, mode = "GPS actif" }) {
  if (!routeLine.length) {
    $("#guidanceNote").textContent = "Aucun itinéraire actif. Retournez au planificateur.";
    return;
  }

  const nearestIndex = nearestRouteIndex(position);
  const activeStep = activeStepIndex(nearestIndex);
  const targetIndex = Math.min(routeLine.length - 1, nearestIndex + 4);
  const nextPoint = routeLine[targetIndex];
  const routeBearing = bearingBetween(position, nextPoint);
  const activeBearing = Number.isFinite(heading) && speed > 1.5 ? heading : routeBearing;
  const nextDistance = distanceBetween(position, nextPoint);
  const remaining = remainingDistanceFrom(nearestIndex);
  const delta = (routeBearing - activeBearing + 360) % 360;
  const turnLabel = Math.abs(((routeBearing - activeBearing + 540) % 360) - 180) < 25
    ? "Continuez tout droit"
    : delta > 180
      ? "Gardez la gauche"
      : "Gardez la droite";

  $("#navWorld").style.transform = `rotate(${-activeBearing}deg)`;
  $("#navCompass").style.transform = `translate(-50%, -50%) rotate(${activeBearing}deg)`;
  $("#guidanceMode").textContent = mode;
  $("#guidanceSpeed").textContent = `${Math.max(0, Math.round(speed * 3.6))} km/h`;
  $("#maneuverDistance").textContent = formatMeters(nextDistance);
  $("#maneuverText").textContent = `${turnLabel} vers ${destinationLabel || "la destination"}`;
  $("#bearingText").textContent = `Cap navigation : ${Math.round(activeBearing)}° · reste ${formatMeters(remaining)}`;
  $("#guidanceNote").textContent = "Mode navigation : le haut de l'écran correspond au sens de déplacement.";
  renderSteps(activeStep);
}

function stopGuidance() {
  if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

function startActiveGuidance() {
  if (!routeLine.length) {
    showToast("Guidage indisponible", "Calculez d'abord un itinéraire.");
    return;
  }

  if (!navigator.geolocation) {
    $("#guidanceNote").textContent = "Géolocalisation non disponible sur cet appareil ou ce navigateur.";
    return;
  }

  stopGuidance();
  $("#guidanceMode").textContent = "GPS...";
  $("#guidanceNote").textContent = "Autorisez la géolocalisation pour démarrer le guidage actif.";

  watchId = navigator.geolocation.watchPosition((position) => {
    const coords = position.coords;
    updateGuidanceScreen({
      position: [coords.latitude, coords.longitude],
      speed: coords.speed || 0,
      heading: coords.heading,
      mode: "GPS actif"
    });
  }, () => {
    $("#guidanceNote").textContent = "Position refusée ou indisponible : autorisez la géolocalisation pour le guidage actif.";
    $("#guidanceMode").textContent = "Position requise";
  }, {
    enableHighAccuracy: true,
    maximumAge: 2500,
    timeout: 10000
  });
}

function loadRoute() {
  const stored = localStorage.getItem("voltwayGuidanceRoute");
  if (!stored) {
    $("#guidanceNote").textContent = "Aucun itinéraire chargé. Retournez au planificateur pour calculer un trajet.";
    return;
  }

  try {
    const route = JSON.parse(stored);
    routeLine = Array.isArray(route.line) ? route.line : [];
    routeDistance = Number(route.distance || 0);
    routeDuration = Number(route.duration || 0);
    averageSpeedKmh = Number(route.averageSpeedKmh || 0);
    destinationLabel = route.destination || "";
    $("#guidanceNote").textContent = route.weather || "Itinéraire chargé.";
    buildGuidanceSteps();
    updateGuidancePreview();
    renderSteps(0);
  } catch (error) {
    $("#guidanceNote").textContent = "Itinéraire illisible. Recalculez le trajet depuis le planificateur.";
  }
}

$("#activateGuidanceButton").addEventListener("click", startActiveGuidance);

loadRoute();

const mode = new URLSearchParams(window.location.search).get("mode");
if (mode === "active") startActiveGuidance();
