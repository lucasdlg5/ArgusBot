'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Plus, Store, X } from 'lucide-react';

export interface StoreComboboxOption {
  id?: string;
  name: string;
  subtitle?: string;
  searchHint?: string;
}

interface ArgusStoreComboboxProps {
  value: string;
  onChange: (value: string, selectedOption?: StoreComboboxOption) => void;
  options: StoreComboboxOption[];
  allowCreate?: boolean;
  required?: boolean;
  placeholder?: string;
  label?: string;
  allOptionLabel?: string;
  allOptionValue?: string;
  compact?: boolean;
  hidePlaceholders?: boolean;
  ariaLabel?: string;
  className?: string;
}

const GENERIC_PLACEHOLDER_STORES = new Set([
  'mercado identificado',
  'mercado desconhecido',
  'mercado nao identificado',
  'estabelecimento desconhecido',
  'estabelecimento nao identificado',
  'loja desconhecida',
  'loja nao identificada',
  'sem mercado',
  'desconhecido'
]);

export function normalizeStoreOptionText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function isGenericStorePlaceholder(name: string): boolean {
  const normalized = normalizeStoreOptionText(name);
  return !normalized || GENERIC_PLACEHOLDER_STORES.has(normalized);
}

export function ArgusStoreCombobox({
  value,
  onChange,
  options,
  allowCreate = false,
  required = false,
  placeholder = 'Selecione um mercado ou digite...',
  label,
  allOptionLabel,
  allOptionValue = 'ALL',
  compact = false,
  hidePlaceholders = true,
  ariaLabel,
  className = ''
}: ArgusStoreComboboxProps) {
  const [open, setOpen] = useState(false);
  const [filterActive, setFilterActive] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [localQuery, setLocalQuery] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = useMemo(
    () => `argus-store-listbox-${Math.random().toString(36).slice(2, 8)}`,
    []
  );

  const normalizedOptions = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<StoreComboboxOption & { normalized: string; normalizedSearch: string }> = [];
    for (const opt of options) {
      const cleanName = (opt.name || '').trim();
      if (!cleanName) continue;
      if (hidePlaceholders && isGenericStorePlaceholder(cleanName)) continue;
      const normalized = normalizeStoreOptionText(cleanName);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      list.push({
        ...opt,
        name: cleanName,
        normalized,
        normalizedSearch: normalizeStoreOptionText(
          `${cleanName} ${opt.subtitle || ''} ${opt.searchHint || ''}`
        )
      });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }, [options, hidePlaceholders]);

  const selectedOption = useMemo(() => {
    if (allOptionLabel && value === allOptionValue) return null;
    const normVal = normalizeStoreOptionText(value);
    return (
      normalizedOptions.find((opt) => (opt.id && opt.id === value) || opt.normalized === normVal) ||
      null
    );
  }, [normalizedOptions, value, allOptionLabel, allOptionValue]);

  const displayText = allowCreate
    ? value
    : open && filterActive
      ? localQuery
      : allOptionLabel && value === allOptionValue
        ? allOptionLabel
        : selectedOption?.name || value;

  const queryTrimmed = (allowCreate ? value : localQuery).trim();
  const queryNormalized = normalizeStoreOptionText(queryTrimmed);

  const filteredOptions = useMemo(() => {
    if (!filterActive || !queryNormalized) {
      return normalizedOptions;
    }
    return normalizedOptions.filter((opt) => opt.normalizedSearch.includes(queryNormalized));
  }, [normalizedOptions, filterActive, queryNormalized]);

  const canCreateNew = useMemo(() => {
    if (!allowCreate || !queryTrimmed) return false;
    if (isGenericStorePlaceholder(queryTrimmed)) return false;
    return !normalizedOptions.some((opt) => opt.normalized === queryNormalized);
  }, [allowCreate, queryTrimmed, queryNormalized, normalizedOptions]);

  // Detecta se o texto novo digitado é muito parecido com um mercado já existente (previne duplicatas)
  const similarExistingStore = useMemo(() => {
    if (!canCreateNew || queryNormalized.length < 3) return null;
    return (
      normalizedOptions.find(
        (opt) =>
          opt.normalized.includes(queryNormalized) ||
          queryNormalized.includes(opt.normalized)
      ) || null
    );
  }, [canCreateNew, queryNormalized, normalizedOptions]);

  useEffect(() => {
    if (!open) return;
    function handleOutsideClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
        setFilterActive(false);
        setLocalQuery('');
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  function handleSelectOption(opt: StoreComboboxOption) {
    const nextValue = allowCreate ? opt.name : opt.id || opt.name;
    onChange(nextValue, opt);
    setOpen(false);
    setFilterActive(false);
    setLocalQuery('');
  }

  function handleSelectAll() {
    if (!allOptionLabel) return;
    onChange(allOptionValue, undefined);
    setOpen(false);
    setFilterActive(false);
    setLocalQuery('');
  }

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {label && (
        <label className="mb-1 flex items-center justify-between font-medium text-slate-300">
          <span>{label}</span>
          {allowCreate && canCreateNew ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
              <Plus className="h-2.5 w-2.5" />
              Novo mercado
            </span>
          ) : (
            <span className="text-[10px] font-normal text-slate-500">
              {normalizedOptions.length} disponíveis
            </span>
          )}
        </label>
      )}

      <div className="relative flex items-center">
        <Store
          className={`pointer-events-none absolute left-2.5 shrink-0 ${
            compact ? 'h-3.5 w-3.5 text-slate-500' : 'left-3 h-3.5 w-3.5 text-emerald-400'
          }`}
        />
        <input
          ref={inputRef}
          type="text"
          required={required}
          role="combobox"
          aria-label={ariaLabel || label || 'Selecionar mercado'}
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={listboxId}
          placeholder={placeholder}
          value={displayText}
          onFocus={() => {
            setOpen(true);
            setFilterActive(false);
            setActiveIndex(0);
            if (!allowCreate) setLocalQuery('');
          }}
          onChange={(e) => {
            const val = e.target.value;
            if (allowCreate) {
              onChange(val, undefined);
            } else {
              setLocalQuery(val);
            }
            setOpen(true);
            setFilterActive(true);
            setActiveIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              if (filteredOptions.length > 0) {
                setActiveIndex((prev) => (prev + 1) % filteredOptions.length);
              }
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setOpen(true);
              if (filteredOptions.length > 0) {
                setActiveIndex((prev) => (prev - 1 + filteredOptions.length) % filteredOptions.length);
              }
            } else if (e.key === 'Enter' && open) {
              const chosen = filteredOptions[activeIndex];
              if (chosen) {
                e.preventDefault();
                handleSelectOption(chosen);
              } else if (allowCreate && canCreateNew) {
                e.preventDefault();
                setOpen(false);
                setFilterActive(false);
              }
            } else if (e.key === 'Escape' && open) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              setFilterActive(false);
              setLocalQuery('');
            }
          }}
          className={
            compact
              ? 'w-full rounded-lg border border-slate-800 bg-slate-950 pl-8 pr-11 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none'
              : 'w-full rounded-lg border border-slate-700 bg-slate-950 pl-9 pr-14 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none'
          }
        />

        <div className="absolute right-1.5 flex items-center gap-0.5">
          {((allowCreate && value) || (!allowCreate && allOptionLabel && value !== allOptionValue)) && (
            <button
              type="button"
              title={allowCreate ? 'Limpar nome do mercado' : 'Mostrar todos os mercados'}
              onClick={() => {
                if (allowCreate) {
                  onChange('', undefined);
                  setOpen(true);
                  setFilterActive(false);
                  setActiveIndex(0);
                  inputRef.current?.focus();
                } else {
                  handleSelectAll();
                }
              }}
              className="rounded-md p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200 transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            title={open ? 'Fechar lista de mercados' : 'Ver mercados disponíveis'}
            onClick={() => {
              setOpen((prev) => {
                const next = !prev;
                if (next) {
                  setFilterActive(false);
                  setLocalQuery('');
                  setActiveIndex(0);
                }
                return next;
              });
            }}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-colors"
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform duration-150 ${
                open ? 'rotate-180 text-emerald-400' : ''
              }`}
            />
          </button>
        </div>
      </div>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-40 mt-1.5 min-w-[230px] overflow-hidden rounded-xl border border-slate-700 bg-slate-950 shadow-2xl"
        >
          {allowCreate && canCreateNew && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(queryTrimmed, undefined);
                setOpen(false);
                setFilterActive(false);
              }}
              className="flex w-full items-center justify-between gap-2 border-b border-slate-800 bg-emerald-500/10 px-3 py-2.5 text-left hover:bg-emerald-500/20 transition-colors"
            >
              <span className="inline-flex items-center gap-2 min-w-0">
                <Plus className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                <span className="truncate text-xs font-semibold text-emerald-200">
                  Usar novo mercado: &ldquo;{queryTrimmed}&rdquo;
                </span>
              </span>
              <span className="shrink-0 rounded-full border border-emerald-500/40 bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-200">
                Criar
              </span>
            </button>
          )}

          {similarExistingStore && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handleSelectOption(similarExistingStore)}
              className="flex w-full items-center gap-2 border-b border-slate-800 bg-amber-500/10 px-3 py-2 text-left text-[11px] text-amber-200 hover:bg-amber-500/20 transition-colors"
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
              <span className="truncate">
                Já existe parecido: <strong>{similarExistingStore.name}</strong> (clique para usar)
              </span>
            </button>
          )}

          <div className="max-h-56 overflow-y-auto py-1">
            {allOptionLabel && (!filterActive || !queryNormalized) && (
              <button
                type="button"
                role="option"
                aria-selected={value === allOptionValue}
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleSelectAll}
                className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors ${
                  value === allOptionValue
                    ? 'bg-emerald-500/15 font-semibold text-emerald-200'
                    : 'text-slate-300 hover:bg-slate-800/70'
                }`}
              >
                <span>{allOptionLabel}</span>
                {value === allOptionValue && <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0" />}
              </button>
            )}

            {filteredOptions.length === 0 ? (
              <div className="px-3 py-3 text-center text-[11px] text-slate-400">
                {allowCreate
                  ? 'Nenhum mercado cadastrado encontrado. Pressione Salvar para cadastrar este novo nome.'
                  : 'Nenhum mercado encontrado para esta busca.'}
              </div>
            ) : (
              filteredOptions.map((opt, idx) => {
                const isSelected = allowCreate
                  ? opt.normalized === queryNormalized
                  : (opt.id ? opt.id === value : opt.normalized === normalizeStoreOptionText(value));
                const isActive = idx === activeIndex;
                return (
                  <button
                    key={opt.id || opt.normalized}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handleSelectOption(opt)}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors ${
                      isSelected
                        ? 'bg-emerald-500/15 text-emerald-200'
                        : isActive
                          ? 'bg-slate-800/90 text-white'
                          : 'text-slate-200 hover:bg-slate-800/70'
                    }`}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold">{opt.name}</p>
                      {opt.subtitle && (
                        <p className="truncate text-[10px] text-slate-400">{opt.subtitle}</p>
                      )}
                    </div>
                    {isSelected && <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}

      {allowCreate && label && (
        <p className={`mt-1 text-[10px] ${canCreateNew ? 'text-emerald-400/90' : 'text-slate-500'}`}>
          {canCreateNew
            ? 'Ao salvar, este novo mercado será criado automaticamente e vinculado à nota.'
            : 'Escolha um mercado existente na lista ou digite um nome novo.'}
        </p>
      )}
    </div>
  );
}
