"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Popover } from "radix-ui";
import { ExperienceSelect } from "./ExperienceSelect";
import "./experience-date-picker.css";

export interface ExperienceDatePickerProps {
  id?: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (iso: string) => void;
  min?: string;
  max?: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}
const DAY = 86400000;
const WEEK = ["一", "二", "三", "四", "五", "六", "日"];
function validISO(value?: string): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number(value.slice(0, 4)) >= 1 && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function dateISO(value: Date) { return value.toISOString().slice(0, 10); }
function todayISO() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function monthKey(value: string) { return Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1; }
function monthStart(month: number) { return `${String(Math.floor(month / 12)).padStart(4, "0")}-${String(month % 12 + 1).padStart(2, "0")}-01`; }
function lastDay(month: number) { const date = new Date(`${monthStart(month)}T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() + 1); date.setUTCDate(0); return dateISO(date); }
function label(value: string) { return `${Number(value.slice(0, 4))}年${Number(value.slice(5, 7))}月${Number(value.slice(8))}日`; }

/** Styled calendar with a real form field: native form validity and FormData both work. */
export function ExperienceDatePicker({
  id, name, value, defaultValue = "", onValueChange, min, max, required = false,
  disabled = false, placeholder = "选择日期", className = "",
  "aria-label": ariaLabel, "aria-describedby": ariaDescribedBy,
}: ExperienceDatePickerProps) {
  const generatedId = useId(), calendarId = `exp-calendar-${generatedId.replace(/:/g, "")}`;
  const triggerRef = useRef<HTMLButtonElement>(null), fieldRef = useRef<HTMLInputElement>(null), activeDayRef = useRef<HTMLButtonElement>(null);
  const focusAfterMove = useRef(false);
  const [internal, setInternal] = useState(defaultValue), [open, setOpen] = useState(false), [invalidAttempt, setInvalidAttempt] = useState(false);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const current = value === undefined ? internal : value;
  const selected = validISO(current) ? current : "";
  const lower = validISO(min) ? min : "0001-01-01", upper = validISO(max) ? max : "9999-12-31";
  const clamp = (date: string) => date < lower ? lower : date > upper ? upper : date;
  const today = todayISO(), preferred = clamp(selected || today);
  const [viewMonth, setViewMonth] = useState(() => monthKey(preferred)), [activeDate, setActiveDate] = useState(preferred);
  const minMonth = monthKey(lower), maxMonth = monthKey(upper);
  const year = Math.floor(viewMonth / 12), month = viewMonth % 12 + 1;
  const yearMin = Math.max(1, Math.min(1900, year, validISO(min) ? Number(min.slice(0, 4)) : 1900, selected ? Number(selected.slice(0, 4)) : 1900));
  const yearMax = Math.min(9999, Math.max(2100, year, validISO(max) ? Number(max.slice(0, 4)) : 2100, selected ? Number(selected.slice(0, 4)) : 2100));
  const visibleYearMin = validISO(min) ? Math.max(yearMin, Number(min.slice(0, 4))) : yearMin;
  const visibleYearMax = validISO(max) ? Math.min(yearMax, Number(max.slice(0, 4))) : yearMax;
  const years = Array.from({ length: Math.max(0, visibleYearMax - visibleYearMin + 1) }, (_, index) => {
    const item = visibleYearMin + index;
    return { value: String(item), label: `${item}年`, disabled: item * 12 + 11 < minMonth || item * 12 > maxMonth };
  });
  const months = Array.from({ length: 12 }, (_, index) => ({ value: String(index + 1), label: `${index + 1}月`, disabled: year * 12 + index < minMonth || year * 12 + index > maxMonth }));
  const first = Date.parse(`${monthStart(viewMonth)}T00:00:00Z`), offset = (new Date(first).getUTCDay() + 6) % 7;
  const days = Array.from({ length: 42 }, (_, index) => dateISO(new Date(first + (index - offset) * DAY)));
  const validationError = current && !selected ? "请选择有效日期。" : selected && (selected < lower || selected > upper) ? "请选择允许范围内的日期。" : required && !selected ? "请选择日期后继续。" : "";
  const errorId = `${calendarId}-error`, valueDescriptionId = `${calendarId}-value`, describedBy = [ariaDescribedBy, valueDescriptionId, invalidAttempt && validationError ? errorId : ""].filter(Boolean).join(" ") || undefined;

  useEffect(() => { fieldRef.current?.setCustomValidity(validationError); }, [validationError]);
  useEffect(() => {
    if (open && focusAfterMove.current) { focusAfterMove.current = false; activeDayRef.current?.focus(); }
  }, [activeDate, viewMonth, open]);

  function onOpenChange(next: boolean) {
    if (disabled) return;
    if (next) { setPortalContainer(triggerRef.current?.closest<HTMLElement>("dialog[open]") || null); setViewMonth(monthKey(preferred)); setActiveDate(preferred); }
    setOpen(next);
  }
  function choose(date: string) {
    if (disabled || date && (!validISO(date) || date < lower || date > upper)) return;
    if (value === undefined) setInternal(date);
    setInvalidAttempt(false); onValueChange?.(date); setOpen(false);
  }
  function moveMonth(next: number) {
    const target = Math.max(minMonth, Math.min(maxMonth, next));
    const day = Math.min(Number(activeDate.slice(8)) || 1, Number(lastDay(target).slice(8)));
    setViewMonth(target); setActiveDate(clamp(`${monthStart(target).slice(0, 8)}${String(day).padStart(2, "0")}`));
  }
  function dayKey(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    let target: string | undefined;
    const movement: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (event.key in movement) target = dateISO(new Date(Date.parse(`${date}T00:00:00Z`) + movement[event.key] * DAY));
    if (event.key === "Home" || event.key === "End") { const day = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7; target = dateISO(new Date(Date.parse(`${date}T00:00:00Z`) + ((event.key === "Home" ? 0 : 6) - day) * DAY)); }
    if (event.key === "PageUp" || event.key === "PageDown") {
      const next = Math.max(minMonth, Math.min(maxMonth, monthKey(date) + (event.key === "PageUp" ? -1 : 1)));
      target = `${monthStart(next).slice(0, 8)}${String(Math.min(Number(date.slice(8)), Number(lastDay(next).slice(8)))).padStart(2, "0")}`;
    }
    if (!target) return;
    event.preventDefault(); event.stopPropagation(); focusAfterMove.current = true;
    const beyondUpper = target.startsWith("+");
    if (!validISO(target)) target = beyondUpper ? upper : lower;
    target = clamp(target); setActiveDate(target); setViewMonth(monthKey(target));
  }

  return <Popover.Root open={open} onOpenChange={onOpenChange} modal>
    <span className={`exp-date-field ${className}`.trim()}>
      <Popover.Trigger asChild><button ref={triggerRef} id={id} type="button" role="combobox" aria-haspopup="dialog" aria-autocomplete="none" aria-controls={calendarId} aria-expanded={open} className="exp-date-trigger" disabled={disabled} aria-label={ariaLabel} aria-describedby={describedBy} aria-required={required || undefined} aria-invalid={invalidAttempt && !!validationError || undefined} data-empty={!selected || undefined} onKeyDown={event => { if (event.key === "ArrowDown" && !open) { event.preventDefault(); onOpenChange(true); } }}>
        <CalendarDays size={16} aria-hidden="true"/><span>{selected ? selected.replaceAll("-", " / ") : placeholder}</span><ChevronDown size={14} className="exp-date-chevron" aria-hidden="true"/>
      </button></Popover.Trigger>
      <input ref={fieldRef} name={name} type="text" className="exp-date-form-value" aria-hidden="true" tabIndex={-1} value={selected} required={required} disabled={disabled} onChange={() => {}} onInvalid={event => { event.preventDefault(); setInvalidAttempt(true); triggerRef.current?.focus(); }}/>
      <span id={valueDescriptionId} className="exp-date-form-value">{selected ? `已选 ${label(selected)}` : "未选择日期"}</span>
      {invalidAttempt && validationError && <span id={errorId} className="exp-date-error" role="alert">{validationError}</span>}
    </span>
    <Popover.Portal container={portalContainer}><Popover.Content id={calendarId} className="exp-date-popup" align="start" sideOffset={8} collisionPadding={16} data-exp-date-popup="" aria-label={ariaLabel || "选择日期"} onEscapeKeyDown={event => event.stopPropagation()} onOpenAutoFocus={event => { event.preventDefault(); activeDayRef.current?.focus(); }}>
      <div className="exp-date-heading"><span>选择日期</span><small>北京时间</small></div>
      <div className="exp-date-navigation">
        <button type="button" className="exp-date-month-step" aria-label="上个月" disabled={viewMonth <= minMonth || disabled} onClick={() => moveMonth(viewMonth - 1)}><ChevronLeft size={16}/></button>
        <ExperienceSelect aria-label="选择年份" value={String(year)} onValueChange={next => moveMonth(Number(next) * 12 + month - 1)} options={years} className="exp-date-year" disabled={disabled}/>
        <ExperienceSelect aria-label="选择月份" value={String(month)} onValueChange={next => moveMonth(year * 12 + Number(next) - 1)} options={months} className="exp-date-month" disabled={disabled}/>
        <button type="button" className="exp-date-month-step" aria-label="下个月" disabled={viewMonth >= maxMonth || disabled} onClick={() => moveMonth(viewMonth + 1)}><ChevronRight size={16}/></button>
      </div>
      <div className="exp-date-grid" role="grid" aria-label={`${year}年${month}月`}>
        <div className="exp-date-week" role="row">{WEEK.map(day => <span key={day} role="columnheader">{day}</span>)}</div>
        {Array.from({ length: 6 }, (_, row) => <div className="exp-date-week" role="row" key={row}>{days.slice(row * 7, row * 7 + 7).map(date => {
          if (!validISO(date)) return <span role="gridcell" key={date}/>;
          const unavailable = !validISO(date) || date < lower || date > upper || disabled;
          return <span role="gridcell" aria-selected={date === selected} key={date}><button type="button" ref={date === activeDate ? activeDayRef : undefined} className={`exp-date-day ${date.slice(0, 7) !== monthStart(viewMonth).slice(0, 7) ? "outside" : ""} ${date === selected ? "selected" : ""} ${date === today ? "today" : ""}`} disabled={unavailable} data-date={date} aria-label={label(date)} aria-pressed={date === selected} aria-current={date === today ? "date" : undefined} tabIndex={date === activeDate && !unavailable ? 0 : -1} onClick={() => choose(date)} onKeyDown={event => dayKey(event,date)}>{Number(date.slice(8))}</button></span>;
        })}</div>)}
      </div>
      <div className="exp-date-footer"><button type="button" disabled={disabled || today < lower || today > upper} onClick={() => choose(today)}>今天</button><span>{min || max ? "已按可选范围限制日期" : "支持键盘方向键选择"}</span>{!required && <button type="button" disabled={disabled || !selected} onClick={() => choose("")}>清除</button>}</div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
