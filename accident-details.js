/* Recorded accidents are separate from the hypothetical conflict actors. */
(function () {
  "use strict";

  window.installAccidentStatistics = async function (viewer, { roadSamples, correction }) {
    const response = await fetch("./GeoJSON/Accident_statistics.geojson");
    if (!response.ok) throw new Error(`Accident statistics: HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.features)) throw new Error("Unexpected accident GeoJSON");

    const panel = document.getElementById("accidentPanel");
    const detail = document.getElementById("accidentDetail");
    const detailTitle = document.getElementById("accidentDetailTitle");
    const detailRowsElement = document.getElementById("accidentDetailRows");
    const title = document.getElementById("accidentTitle");
    const summary = document.getElementById("accidentSummary");
    const bikeOnlyButton = document.getElementById("accidentBikeOnly");
    let bikeOnly = false;
    const byIntersection = new Map();
    const byId = new Map();
    let selectedName = null;
    let mode = "real";
    let selectedAccident = null;
    let povActive = false;
    function impactIcon(bikeRelated) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const ctx = canvas.getContext("2d");
      ctx.translate(32, 32);
      ctx.beginPath();
      for (let i = 0; i < 20; i++) {
        const angle = -Math.PI / 2 + i * Math.PI / 10;
        const radius = i % 2 === 0 ? 28 : 17;
        const x = radius * Math.cos(angle), y = radius * Math.sin(angle);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = bikeRelated ? "#ff9545" : "#aab3ba";
      ctx.strokeStyle = "#26333e";
      ctx.lineWidth = 4;
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-8, -8); ctx.lineTo(8, 8);
      ctx.moveTo(8, -8); ctx.lineTo(-8, 8);
      ctx.lineWidth = 5;
      ctx.strokeStyle = "#26333e";
      ctx.stroke();
      return canvas;
    }
    const carBikeIcon = impactIcon(true);
    const otherIcon = impactIcon(false);
    document.getElementById("bikeAccidentSymbol").src = carBikeIcon.toDataURL();
    document.getElementById("otherAccidentSymbol").src = otherIcon.toDataURL();
    // Codes are defined in DSB_Unfallatlas_EN.pdf (Accident Atlas data record).
    const severityLabels = {
      1: "Fatal injury crash", 2: "Serious injury crash", 3: "Slight injury crash"
    };
    const accidentTypes = {
      1: "Driving accident", 2: "Turning off a road", 3: "Entering or crossing a road",
      4: "Crossing a road", 5: "Involving a stationary vehicle",
      6: "Vehicles travelling along a carriageway", 7: "Other type"
    };
    const collisionKinds = {
      0: "Other kind", 1: "Collision with a starting, stopping or stationary vehicle",
      2: "Collision with a vehicle ahead or waiting",
      3: "Collision with a vehicle moving laterally in the same direction",
      4: "Collision with an oncoming vehicle",
      5: "Collision with a vehicle turning into or crossing a road",
      6: "Collision with a pedestrian", 7: "Collision with an obstacle on the road",
      8: "Leaving the road to the right", 9: "Leaving the road to the left"
    };
    const lightLabels = { 0: "Daylight", 1: "Twilight", 2: "Darkness" };
    const roadLabels = { 0: "Dry", 1: "Wet, damp or slippery", 2: "Winter slipperiness" };
    const weekdays = {
      1: "Sunday", 2: "Monday", 3: "Tuesday", 4: "Wednesday",
      5: "Thursday", 6: "Friday", 7: "Saturday"
    };
    const months = ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"];
    const labelFor = (labels, code) => labels[String(code ?? "").trim()] || "Not recorded";

    function nearestRoadHeight(lon, lat) {
      let best = Infinity;
      let height = 0;
      for (const road of roadSamples) {
        const d = (road.lon - lon) ** 2 * 0.44 + (road.lat - lat) ** 2;
        if (d < best) { best = d; height = road.height; }
      }
      return height;
    }

    for (const feature of data.features) {
      if (feature.geometry?.type !== "Point") continue;
      const p = feature.properties || {};
      const name = String(p.Intersecti ?? "").trim();
      // This source also covers other locations along Rheinstrasse.
      if (!name) continue;
      const [lon, lat] = feature.geometry.coordinates;
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const carBike = Number(p.IstRad) === 1 && Number(p.IstPKW) === 1;
      const bikeRelated = Number(p.IstRad) === 1;
      const item = { carBike, bikeRelated };
      const year = Number(p.UJAHR);
      const month = Number(p.UMONAT);
      const date = Number.isInteger(year) && month >= 1 && month <= 12
        ? `${months[month - 1]} ${year}` : "Date unavailable";
      const hour = Number(p.USTUNDE);
      const time = Number.isInteger(hour) && hour >= 0 && hour < 24
        ? `${String(hour).padStart(2, "0")}:00–${String(hour).padStart(2, "0")}:59`
        : "Time unavailable";
      const participants = [
        ["Bicycle", p.IstRad], ["Passenger car", p.IstPKW],
        ["Pedestrian", p.IstFuss], ["Motorcycle", p.IstKrad],
        ["Goods vehicle", p.IstGkfz], ["Other road user", p.IstSonstig]
      ].filter(([, flag]) => Number(flag) === 1).map(([label]) => label).join(", ");
      const detailRows = [
        ["When", `${date} · ${labelFor(weekdays, p.UWOCHENTAG)} · ${time}`],
        ["Severity", labelFor(severityLabels, p.UKATEGORIE)],
        ["Crash type", labelFor(accidentTypes, p.UTYP1)],
        ["Collision type", labelFor(collisionKinds, p.UART)],
        ["Road users involved", participants || "Not recorded"],
        ["Light conditions", labelFor(lightLabels, p.ULICHTVERH)],
        ["Road surface", labelFor(roadLabels, p.IstStrasse)]
      ];
      item.detailRows = detailRows;
      item.date = date;
      item.severity = String(p.UKATEGORIE ?? "").trim();
      item.entity = viewer.entities.add({
        id: `recorded-accident-${p.FID}`,
        name: `Recorded injury crash · ${date}`,
        description: `<table><tbody>${detailRows.map(([key, value]) =>
          `<tr><th style="text-align:left;padding:4px 12px 4px 0">${key}</th>` +
          `<td>${value}</td></tr>`).join("")}</tbody></table>` +
          `<p>Recorded crash location. This record is not linked to a simulated ` +
          `conflict animation. The dataset does not establish the exact sequence ` +
          `of events or whether the vehicle was turning left or right.</p>`,
        show: false,
        position: Cesium.Cartesian3.fromDegrees(lon, lat,
          nearestRoadHeight(lon, lat) + correction + 1.5),
        billboard: {
          image: bikeRelated ? carBikeIcon : otherIcon,
          width: 30, height: 30,
          heightReference: Cesium.HeightReference.NONE
        }
      });
      if (!byIntersection.has(name)) byIntersection.set(name, []);
      byIntersection.get(name).push(item);
      byId.set(item.entity.id, item);
    }

    function update() {
      panel.hidden = mode !== "scenario";
      bikeOnlyButton.setAttribute("aria-pressed", String(bikeOnly));
      bikeOnlyButton.textContent = bikeOnly ? "Show all accidents" : "Bicycle accidents only";
      bikeOnlyButton.disabled = !selectedName;
      const accidents = byIntersection.get(selectedName) || [];
      for (const [name, entries] of byIntersection) {
        for (const item of entries) {
          item.entity.show = mode === "scenario" && !povActive && name === selectedName &&
            (!bikeOnly || item.bikeRelated);
        }
      }
      if (panel.hidden) return;
      const carBike = accidents.filter(item => item.carBike).length;
      const serious = accidents.filter(item => item.carBike && item.severity === "2").length;
      const fatal = accidents.filter(item => item.carBike && item.severity === "1").length;
      title.textContent = selectedName || "Intersection safety";
      summary.replaceChildren();
      if (selectedName) {
        const rows = [
          ["All injury accidents", accidents.length],
          ["Bicycle involved", accidents.filter(item => item.bikeRelated).length],
          ["Bicycle + passenger car", carBike]
        ];
        const list = document.createElement("dl");
        list.className = "accidentCounts";
        for (const [label, count] of rows) {
          const dt = document.createElement("dt"), dd = document.createElement("dd");
          dt.textContent = label; dd.textContent = count;
          list.append(dt, dd);
        }
        const note = document.createElement("p");
        note.className = "panelNote";
        note.textContent = `Bicycle + car: ${fatal} fatal · ${serious} serious · ${carBike - fatal - serious} slight.`;
        summary.append(list, note);
      } else {
        summary.textContent = "Select an intersection on the map.";
      }
      detail.hidden = !selectedAccident;
      if (selectedAccident) {
        detailTitle.textContent = selectedAccident.date;
        detailRowsElement.replaceChildren();
        for (const [label, value] of selectedAccident.detailRows) {
          const dt = document.createElement("dt"), dd = document.createElement("dd");
          dt.textContent = label; dd.textContent = value;
          detailRowsElement.append(dt, dd);
        }
      }
    }

    bikeOnlyButton.addEventListener("click", () => { bikeOnly = !bikeOnly; update(); });
    viewer.selectedEntityChanged.addEventListener(entity => {
      selectedAccident = entity ? byId.get(entity.id) || null : null;
      update();
      if (selectedAccident) detail.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    });
    document.getElementById("closeAccidentDetail").addEventListener("click", () => {
      selectedAccident = null;
      viewer.selectedEntity = undefined;
      update();
      panel.scrollTop = 0;
    });
    return {
      selectIntersection(name) {
        selectedName = name; selectedAccident = null; update(); panel.scrollTop = 0;
      },
      setPovActive(active) { povActive = active; update(); },
      setMode(next) {
        mode = next;
        if (next !== "scenario") { selectedName = null; selectedAccident = null; }
        update();
      }
    };
  };
}());
