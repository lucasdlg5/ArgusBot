'use client';

import React, { useEffect } from 'react';
import {
  MapContainer,
  TileLayer,
  Polyline,
  CircleMarker,
  Popup,
  useMap
} from 'react-leaflet';
import type { LogisticsScenario } from '@/types/argus';
import 'leaflet/dist/leaflet.css';

interface ArgusLogisticsMapProps {
  homeLocation: { lat: number; lng: number; address: string };
  singleScenario: LogisticsScenario;
  splitScenario: LogisticsScenario;
  activeMode: 'SINGLE_STORE' | 'SPLIT_STORES';
}

function MapBoundsController({
  homeLocation,
  scenario
}: {
  homeLocation: { lat: number; lng: number };
  scenario: LogisticsScenario;
}) {
  const map = useMap();

  useEffect(() => {
    const pts: Array<[number, number]> = [[homeLocation.lat, homeLocation.lng]];
    for (const st of scenario.storesVisited) {
      pts.push([st.lat, st.lng]);
    }
    if (pts.length >= 2) {
      map.fitBounds(pts, { padding: [45, 45] });
    }
  }, [map, homeLocation, scenario]);

  return null;
}

export default function ArgusLogisticsMap({
  homeLocation,
  singleScenario,
  splitScenario,
  activeMode
}: ArgusLogisticsMapProps) {
  const currentScenario = activeMode === 'SPLIT_STORES' ? splitScenario : singleScenario;

  return (
    <div className="relative h-[380px] w-full overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-inner">
      <MapContainer
        center={[homeLocation.lat, homeLocation.lng]}
        zoom={13}
        scrollWheelZoom={false}
        className="h-full w-full z-0"
      >
        {/* Tile gratuito CartoDB Dark Matter / OpenStreetMap (Zero-Cost Stack) */}
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        />

        <MapBoundsController homeLocation={homeLocation} scenario={currentScenario} />

        {/* Polilinhas das Rotas OSRM */}
        {currentScenario.routeLegs.map((leg, idx) => (
          <Polyline
            key={`${leg.fromName}-${leg.toName}-${idx}`}
            positions={leg.coordinates}
            pathOptions={{
              color: idx === 0 ? '#10b981' : idx === 1 ? '#f59e0b' : '#38bdf8',
              weight: 4,
              opacity: 0.9,
              dashArray: idx === currentScenario.routeLegs.length - 1 ? '6, 6' : undefined
            }}
          />
        ))}

        {/* Marcador da Casa */}
        <CircleMarker
          center={[homeLocation.lat, homeLocation.lng]}
          radius={9}
          pathOptions={{
            color: '#10b981',
            fillColor: '#10b981',
            fillOpacity: 0.95,
            weight: 3
          }}
        >
          <Popup>
            <div className="text-xs font-semibold text-slate-900">
              🏠 Minha Casa (Ponto Base Argus)
              <div className="font-normal text-slate-600">{homeLocation.address}</div>
            </div>
          </Popup>
        </CircleMarker>

        {/* Marcadores dos Mercados Visitados */}
        {currentScenario.storesVisited.map((st, idx) => {
          const stopColors = ['#f59e0b', '#38bdf8', '#a855f7', '#fb7185'];
          const stopColor = stopColors[idx % stopColors.length];
          return (
            <CircleMarker
              key={`${st.storeId}-${idx}`}
              center={[st.lat, st.lng]}
              radius={10}
              pathOptions={{
                color: stopColor,
                fillColor: stopColor,
                fillOpacity: 0.9,
                weight: 3
              }}
            >
              <Popup>
                <div className="text-xs text-slate-900">
                  <strong className="block text-sm">
                    🛒 Parada {idx + 1}: {st.storeName}
                  </strong>
                  <span>Itens comprados: {st.itemsCount}</span>
                  <br />
                  <span>Subtotal: R$ {st.subtotalProducts.toFixed(2)}</span>
                </div>
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>

      {/* Legenda flutuante sobre o mapa */}
      <div className="pointer-events-none absolute bottom-3 left-3 z-[400] flex flex-wrap items-center gap-3 rounded-lg border border-slate-800/90 bg-slate-950/90 px-3 py-2 text-xs text-slate-300 backdrop-blur-md">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
          Casa
        </span>
        {currentScenario.storesVisited.map((st, idx) => {
          const dotClasses = ['bg-amber-500', 'bg-sky-400', 'bg-purple-500', 'bg-rose-400'];
          return (
            <span key={`legend-${st.storeId}-${idx}`} className="flex items-center gap-1.5">
              <span className={`h-2.5 w-2.5 rounded-full ${dotClasses[idx % dotClasses.length]}`} />
              {currentScenario.storesVisited.length > 1
                ? `${idx + 1}º ${st.storeName.replace(/^\d+º\s*/, '')}`
                : st.storeName.replace(/^\d+º\s*/, '')}
            </span>
          );
        })}
        <span className="text-slate-400 tabular-nums">
          • Rota OSRM: <strong className="text-emerald-400">{currentScenario.totalDistanceKm} km</strong> ({currentScenario.totalDurationMin} min)
        </span>
      </div>
    </div>
  );
}
