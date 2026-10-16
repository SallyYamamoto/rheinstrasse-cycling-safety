/* Place parked car GLBs using the long side of CRS84 footprint rectangles.
 * Call placeParkedCars(viewer, { roads, correction, model: models[1] })
 * after Munich's road entities have been vertically corrected.
 */
(function () {
  "use strict";

  const METERS_PER_DEGREE = Math.PI / 180 * 6378137;
  // One GLB on disk; only the body-paint material is changed in memory.
  // These are glTF linear base-color factors, not CSS hex colors.
  const BODY_COLORS = [
    { name: "silver", rgba: null }, // keep the original GLB unchanged
    { name: "white", rgba: [0.86, 0.88, 0.86, 1] },
    { name: "graphite", rgba: [0.12, 0.15, 0.17, 1] },
    { name: "navy", rgba: [0.055, 0.11, 0.24, 1] },
    { name: "burgundy", rgba: [0.28, 0.035, 0.055, 1] }
  ];

  async function createBodyColorUris(uri) {
    const response = await fetch(uri);
    if (!response.ok) throw new Error(`Car model: HTTP ${response.status}`);
    const source = await response.arrayBuffer();
    const view = new DataView(source);
    if (source.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 ||
        view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== source.byteLength ||
        view.getUint32(16, true) !== 0x4e4f534a) {
      throw new Error("Car model: expected a glTF 2.0 binary GLB");
    }
    const oldJsonLength = view.getUint32(12, true);
    const endOfJson = 20 + oldJsonLength;
    if (endOfJson > source.byteLength) throw new Error("Car model: truncated GLB JSON");
    const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(source, 20, oldJsonLength)));
    const paint = gltf.materials?.find(material => material.name === "Body Paint - Silver");
    if (!paint?.pbrMetallicRoughness) {
      throw new Error("Car model: Body Paint - Silver material is missing");
    }
    const encode = new TextEncoder();
    return BODY_COLORS.map(color => {
      if (!color.rgba) return uri;
      paint.pbrMetallicRoughness.baseColorFactor = color.rgba;
      const json = encode.encode(JSON.stringify(gltf));
      const paddedLength = (json.length + 3) & ~3;
      const result = new Uint8Array(20 + paddedLength + source.byteLength - endOfJson);
      const header = new DataView(result.buffer);
      header.setUint32(0, 0x46546c67, true);
      header.setUint32(4, 2, true);
      header.setUint32(8, result.length, true);
      header.setUint32(12, paddedLength, true);
      header.setUint32(16, 0x4e4f534a, true);
      result.fill(0x20, 20, 20 + paddedLength);
      result.set(json, 20);
      result.set(new Uint8Array(source, endOfJson), 20 + paddedLength);
      return URL.createObjectURL(new Blob([result], { type: "model/gltf-binary" }));
    });
  }
  const colorUriCache = new Map();
  window.carBodyColorUris = function (uri) {
    if (!colorUriCache.has(uri)) colorUriCache.set(uri, createBodyColorUris(uri));
    return colorUriCache.get(uri);
  };

  function pointInRing(lon, lat, vertices) {
    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
      const a = vertices[i];
      const b = vertices[j];
      if ((a.lat > lat) !== (b.lat > lat) &&
          lon < (b.lon - a.lon) * (lat - a.lat) / (b.lat - a.lat) + a.lon) {
        inside = !inside;
      }
    }
    return inside;
  }

  // Heights in roads already include the correction applied to the CityGML.
  function readRoadSurfaces(roads, time) {
    const parking = [];
    const other = [];
    const vertices = [];
    for (const entity of roads.entities.values) {
      if (!entity.polygon) continue;
      const hierarchy = entity.polygon.hierarchy.getValue(time);
      if (!hierarchy || !hierarchy.positions || hierarchy.positions.length < 3) continue;
      const ring = hierarchy.positions.map(position => {
        const p = Cesium.Cartographic.fromCartesian(position);
        return { lon: Cesium.Math.toDegrees(p.longitude),
          lat: Cesium.Math.toDegrees(p.latitude), z: p.height };
      });
      if (ring.some(p => !Number.isFinite(p.lon) ||
          !Number.isFinite(p.lat) || !Number.isFinite(p.z))) continue;
      const surface = {
        ring,
        minLon: Math.min(...ring.map(p => p.lon)),
        maxLon: Math.max(...ring.map(p => p.lon)),
        minLat: Math.min(...ring.map(p => p.lat)),
        maxLat: Math.max(...ring.map(p => p.lat))
      };
      const category = String(entity.properties?.openDrive1?.getValue(time) ?? "")
        .trim().toUpperCase();
      (category === "PARKING" ? parking : other).push(surface);
      vertices.push(...ring);
    }
    return { parking, other, vertices };
  }

  function heightOnSurface(lon, lat, ring) {
    const northScale = METERS_PER_DEGREE;
    const eastScale = northScale * Math.cos(Cesium.Math.toRadians(lat));
    const closest = ring.map(p => ({
      x: (p.lon - lon) * eastScale,
      y: (p.lat - lat) * northScale,
      z: p.z
    })).sort((a, b) => (a.x * a.x + a.y * a.y) -
      (b.x * b.x + b.y * b.y));
    if (closest[0].x ** 2 + closest[0].y ** 2 < 0.0025) {
      return closest[0].z;
    }
    // Fit a local plane through nearby non-collinear road vertices.
    const a = closest[0];
    for (let i = 1; i < Math.min(closest.length, 7); i++) {
      for (let j = i + 1; j < Math.min(closest.length, 8); j++) {
        const b = closest[i], c = closest[j];
        const det = (b.x - a.x) * (c.y - a.y) -
          (c.x - a.x) * (b.y - a.y);
        if (Math.abs(det) < 0.02) continue;
        const sx = ((b.z - a.z) * (c.y - a.y) -
          (c.z - a.z) * (b.y - a.y)) / det;
        const sy = ((b.x - a.x) * (c.z - a.z) -
          (c.x - a.x) * (b.z - a.z)) / det;
        return a.z - sx * a.x - sy * a.y;
      }
    }
    return a.z;
  }

  function findGroundHeight(lon, lat, surfaces, fallbackSamples, correction) {
    for (const [type, list] of [
      ["parking", surfaces.parking], ["road", surfaces.other]
    ]) {
      for (const surface of list) {
        if (lon < surface.minLon || lon > surface.maxLon ||
            lat < surface.minLat || lat > surface.maxLat ||
            !pointInRing(lon, lat, surface.ring)) continue;
        return { height: heightOnSurface(lon, lat, surface.ring), source: type };
      }
    }

    const eastScale = METERS_PER_DEGREE * Math.cos(Cesium.Math.toRadians(lat));
    let best = { distance2: Infinity, height: NaN, source: "nearest road" };
    for (const p of surfaces.vertices) {
      const d2 = ((p.lon - lon) * eastScale) ** 2 +
        ((p.lat - lat) * METERS_PER_DEGREE) ** 2;
      if (d2 < best.distance2) {
        best = { distance2: d2, height: p.z, source: "nearest road" };
      }
    }
    for (const p of fallbackSamples) {
      const d2 = ((p.lon - lon) * eastScale) ** 2 +
        ((p.lat - lat) * METERS_PER_DEGREE) ** 2;
      if (d2 < best.distance2) {
        best = { distance2: d2, height: p.height + correction,
          source: "road sample" };
      }
    }
    return best;
  }

  window.placeParkedCars = async function (viewer, {
    roads, correction, model
  }) {
    const response = await fetch("./GeoJSON/parked_vehicles.geojson");
    if (!response.ok) throw new Error(`Parked vehicles: HTTP ${response.status}`);
    const data = await response.json();
    const crs = data.crs?.properties?.name;
    if (crs && !/CRS84$/i.test(crs)) {
      throw new Error(`Parked vehicles: unsupported CRS ${crs}`);
    }
    if (!Array.isArray(data.features)) {
      throw new Error("Parked vehicles: missing GeoJSON features");
    }
    const fallbackSamples = await fetch("./rheinstrasse_road_samples.json")
      .then(r => { if (!r.ok) throw new Error(`Road samples: HTTP ${r.status}`);
        return r.json(); });
    const surfaces = readRoadSurfaces(roads, viewer.clock.currentTime);
    const counts = { parking: 0, road: 0, "nearest road": 0,
      "road sample": 0, skipped: 0 };
    const modelLength = model.length;
    if (!(modelLength > 0)) throw new Error("Parked vehicles: invalid model length");
    const colorUris = await window.carBodyColorUris(model.uri);

    for (const [index, feature] of data.features.entries()) {
      // This file contains one closed rectangular ring per MultiPolygon.
      const ring = feature.geometry?.coordinates?.[0]?.[0];
      if (feature.geometry?.type !== "MultiPolygon" || !Array.isArray(ring) ||
          ring.length !== 5) { counts.skipped++; continue; }
      const corners = ring.slice(0, 4);
      if (corners.some(p => p.length < 2 ||
          !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) {
        counts.skipped++; continue;
      }
      const lon = corners.reduce((sum, p) => sum + p[0], 0) / 4;
      const lat = corners.reduce((sum, p) => sum + p[1], 0) / 4;
      const eastScale = METERS_PER_DEGREE * Math.cos(Cesium.Math.toRadians(lat));
      let length = 0;
      let rotationZ = 0;
      for (let i = 0; i < 4; i++) {
        const next = corners[(i + 1) % 4];
        const dx = (next[0] - corners[i][0]) * eastScale;
        const dy = (next[1] - corners[i][1]) * METERS_PER_DEGREE;
        const side = Math.hypot(dx, dy);
        if (side > length) {
          length = side;
          rotationZ = Math.atan2(dy, dx);
        }
      }
      if (length < 1.8 || length > 12) { counts.skipped++; continue; }

      const ground = findGroundHeight(lon, lat, surfaces,
        fallbackSamples, correction);
      if (!Number.isFinite(ground.height)) { counts.skipped++; continue; }
      counts[ground.source]++;
      const scale = length / modelLength;
      const position = Cesium.Cartesian3.fromDegrees(
        lon, lat, ground.height + model.bottomOffset * scale
      );
      // Match the GLB-axis compensation used for moving cars in index.html.
      // A rectangle has no front/rear information; its direction is ambiguous.
      // Cesium heading increases clockwise from north; subtract for CCW.
      const heading = -rotationZ + model.headingOffset - Cesium.Math.toRadians(2);
      const orientation = Cesium.Transforms.headingPitchRollQuaternion(
        position, new Cesium.HeadingPitchRoll(heading, 0, 0)
      );
      viewer.entities.add({
        id: `parked-car-${index}`,
        name: "Parked car",
        position, orientation,
        properties: {
          footprintLength: length,
          confidence: feature.properties?.confidence,
          groundSource: ground.source,
          bodyColor: BODY_COLORS[index % BODY_COLORS.length].name
        },
        model: {
          uri: colorUris[index % colorUris.length],
          scale,
          minimumPixelSize: 0,
          heightReference: Cesium.HeightReference.NONE
        }
      });
    }
    console.log("Parked vehicles placed:", data.features.length - counts.skipped,
      "ground sources:", counts);
    return counts;
  };
}());
