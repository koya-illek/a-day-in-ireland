"use client";

import { useId, useState } from "react";
import type { Place } from "./experience-model";

const searchText = (value: string) => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export function PlacePicker({ places, selected, onChoose, onSearch }: {
  places: Place[];
  selected: Place;
  onChoose: (id: string) => void;
  onSearch: () => void;
}) {
  const id = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const results = query === null ? [] : places.filter((place) => searchText(place.name).includes(searchText(query))).slice(0, 8);
  const choose = (place: Place) => {
    onChoose(place.id);
    setQuery(null);
    setActive(0);
  };
  return (
    <div className="place-search" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setQuery(null);
    }}>
      <label htmlFor={`${id}-input`}>Town or city</label>
      <input id={`${id}-input`} type="search" role="combobox" autoComplete="off"
        aria-autocomplete="list" aria-expanded={query !== null} aria-controls={`${id}-results`}
        aria-activedescendant={query !== null && results[active] ? `${id}-${results[active].id}` : undefined}
        value={query ?? selected.name}
        onFocus={(event) => { onSearch(); setQuery(""); event.target.select(); }}
        onChange={(event) => { setQuery(event.target.value); setActive(0); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") { setQuery(null); return; }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setQuery(query ?? "");
            setActive((index) => Math.max(0, Math.min(results.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
          }
          if (event.key === "Enter" && query !== null && results[active]) {
            event.preventDefault(); choose(results[active]);
          }
        }} />
      {query !== null && <div className="place-search-results">
        <ul id={`${id}-results`} role="listbox" aria-label="Matching places">
          {results.map((place, index) => <li key={place.id} id={`${id}-${place.id}`} role="option" aria-selected={active === index}
            onPointerDown={(event) => event.preventDefault()} onClick={() => choose(place)} onPointerMove={() => setActive(index)}>
            {place.name}
          </li>)}
        </ul>
        <p role="status">{results.length ? "Choose a place. Arrow keys and Enter also work." : "No matching town. Try a nearby town or use your location."}</p>
      </div>}
    </div>
  );
}
