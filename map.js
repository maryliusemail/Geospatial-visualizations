import mapboxgl from "https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm";
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

const BLUEBIKES_STATIONS_URL =
  "https://dsc106.com/labs/lab07/data/bluebikes-stations.json";
const BLUEBIKES_TRAFFIC_URL =
  "https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv";
const BOSTON_BIKE_LANES_URL =
  "https://services.arcgis.com/sFnw0xNflSi8J0uh/arcgis/rest/services/Existing_Bike_Network_2022/FeatureServer/2/query?where=1%3D1&outFields=*&f=geojson";
const CAMBRIDGE_BIKE_LANES_URL =
  "https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson";

let map;
let stationSource = [];
let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute = Array.from({ length: 1440 }, () => []);

mapboxgl.accessToken =
  "pk.eyJ1IjoibWFyeWxpdTEzMzEyIiwiYSI6ImNtcDdkeHVsZDA1cmcycHB1N2R2a3NiYnQifQ.dd_52dtGT5dqpptCfmYHxw";

map = new mapboxgl.Map({
  container: "map",
  style: "mapbox://styles/mapbox/streets-v12",
  center: [-71.09415, 42.36027],
  zoom: 12,
  minZoom: 5,
  maxZoom: 18,
});

map.addControl(new mapboxgl.NavigationControl(), "bottom-right");

function stationId(station) {
  return station.short_name ?? station.Number ?? station.id ?? station.station_id;
}

function stationLongitude(station) {
  return Number(station.lon ?? station.Long ?? station.longitude);
}

function stationLatitude(station) {
  return Number(station.lat ?? station.Lat ?? station.latitude);
}

function stationName(station) {
  return station.name ?? station.NAME ?? "Unknown station";
}

function getCoords(station) {
  const point = new mapboxgl.LngLat(
    stationLongitude(station),
    stationLatitude(station),
  );
  const { x, y } = map.project(point);
  return { cx: x, cy: y };
}

function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleString("en-US", { timeStyle: "short" });
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) {
    return tripsByMinute.flat();
  }

  const minMinute = (minute - 60 + 1440) % 1440;
  const maxMinute = (minute + 60) % 1440;

  if (minMinute > maxMinute) {
    return tripsByMinute.slice(minMinute).concat(tripsByMinute.slice(0, maxMinute + 1)).flat();
  }

  return tripsByMinute.slice(minMinute, maxMinute + 1).flat();
}

function computeStationTraffic(stations, timeFilter = -1) {
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter),
    (trips) => trips.length,
    (trip) => trip.start_station_id,
  );
  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter),
    (trips) => trips.length,
    (trip) => trip.end_station_id,
  );

  return stations.map((station) => {
    const id = stationId(station);
    const stationDepartures = departures.get(id) ?? 0;
    const stationArrivals = arrivals.get(id) ?? 0;

    return {
      ...station,
      departures: stationDepartures,
      arrivals: stationArrivals,
      totalTraffic: stationDepartures + stationArrivals,
    };
  });
}

function tooltipText(station) {
  return `${stationName(station)}
${station.totalTraffic} trips
${station.departures} departures
${station.arrivals} arrivals`;
}

map.on("load", async () => {
  map.resize();

  const bikeLanePaint = {
    "line-color": "#2ba84a",
    "line-width": 4,
    "line-opacity": 0.55,
  };

  map.addSource("boston-bike-lanes", {
    type: "geojson",
    data: BOSTON_BIKE_LANES_URL,
  });

  map.addLayer({
    id: "boston-bike-lanes",
    type: "line",
    source: "boston-bike-lanes",
    paint: bikeLanePaint,
  });

  map.addSource("cambridge-bike-lanes", {
    type: "geojson",
    data: CAMBRIDGE_BIKE_LANES_URL,
  });

  map.addLayer({
    id: "cambridge-bike-lanes",
    type: "line",
    source: "cambridge-bike-lanes",
    paint: bikeLanePaint,
  });

  const [stationData] = await Promise.all([
    d3.json(BLUEBIKES_STATIONS_URL),
    d3.csv(BLUEBIKES_TRAFFIC_URL, (trip) => {
      trip.started_at = new Date(trip.started_at);
      trip.ended_at = new Date(trip.ended_at);

      departuresByMinute[minutesSinceMidnight(trip.started_at)].push(trip);
      arrivalsByMinute[minutesSinceMidnight(trip.ended_at)].push(trip);

      return trip;
    }),
  ]);

  stationSource = stationData.data.stations.filter(
    (station) =>
      Number.isFinite(stationLongitude(station)) &&
      Number.isFinite(stationLatitude(station)) &&
      stationId(station),
  );

  const stations = computeStationTraffic(stationSource);
  const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);
  const radiusScale = d3
    .scaleSqrt()
    .domain([0, d3.max(stations, (station) => station.totalTraffic)])
    .range([0, 25]);

  const svg = d3.select("#map").select("svg");
  const circles = svg
    .selectAll("circle")
    .data(stations, stationId)
    .join("circle");

  function renderCircles(selection) {
    selection
      .attr("r", (station) => radiusScale(station.totalTraffic))
      .style("--departure-ratio", (station) =>
        station.totalTraffic === 0
          ? 0.5
          : stationFlow(station.departures / station.totalTraffic),
      )
      .each(function updateTooltip(station) {
        const circle = d3.select(this);
        const title = circle.selectAll("title").data([station]);
        title.join("title").text(tooltipText);
      });
  }

  function updatePositions() {
    circles
      .attr("cx", (station) => getCoords(station).cx)
      .attr("cy", (station) => getCoords(station).cy);
  }

  function updateScatterPlot(timeFilter) {
    const filteredStations = computeStationTraffic(stationSource, timeFilter);
    radiusScale
      .domain([0, d3.max(filteredStations, (station) => station.totalTraffic)])
      .range(timeFilter === -1 ? [0, 25] : [3, 50]);

    circles.data(filteredStations, stationId).call(renderCircles);
    updatePositions();
  }

  const timeSlider = document.getElementById("time-slider");
  const selectedTime = document.getElementById("selected-time");
  const anyTimeLabel = document.getElementById("any-time");

  function updateTimeDisplay() {
    const timeFilter = Number(timeSlider.value);

    if (timeFilter === -1) {
      selectedTime.textContent = "";
      anyTimeLabel.style.display = "block";
    } else {
      selectedTime.textContent = formatTime(timeFilter);
      anyTimeLabel.style.display = "none";
    }

    updateScatterPlot(timeFilter);
  }

  renderCircles(circles);
  updatePositions();
  map.on("move", updatePositions);
  map.on("zoom", updatePositions);
  map.on("resize", updatePositions);
  map.on("moveend", updatePositions);
  timeSlider.addEventListener("input", updateTimeDisplay);
  updateTimeDisplay();
});
