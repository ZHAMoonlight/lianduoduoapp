"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Clock3 } from "lucide-react";
import { Popover } from "radix-ui";
import "./experience-time-picker.css";

export interface ExperienceTimePickerProps {
  id?: string;
  name?: string;
  form?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (time: string) => void;
  min?: string;
  max?: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}

const HOURS = Array.from({ length: 24 }, (_, index) => index);
const MINUTES = Array.from({ length: 60 }, (_, index) => index);
const pad = (value: number) => String(value).padStart(2, "0");
function parseTime(value?: string): number | null {
  if (!value || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
function timeValue(value: number) { return `${pad(Math.floor(value / 60))}:${pad(value % 60)}`; }
function revealOption(button: HTMLButtonElement | null) {
  const list = button?.parentElement;
  if (!button || !list) return;
  const itemBox = button.getBoundingClientRect(), listBox = list.getBoundingClientRect();
  list.scrollTop += itemBox.top - listBox.top - (list.clientHeight - itemBox.height) / 2;
}
type Column = "hour" | "minute";

/** A transactional time field: scrolling changes a draft; only confirmation changes the form value. */
export function ExperienceTimePicker({
  id, name, form, value, defaultValue = "", onValueChange, min, max,
  required = false, disabled = false, placeholder = "选择时间", className = "",
  "aria-label": ariaLabel, "aria-describedby": ariaDescribedBy,
}: ExperienceTimePickerProps) {
  const generatedId = useId(), popupId = `exp-time-${generatedId.replace(/:/g, "")}`;
  const triggerRef = useRef<HTMLButtonElement>(null), fieldRef = useRef<HTMLInputElement>(null);
  const hourRef = useRef<HTMLButtonElement>(null), minuteRef = useRef<HTMLButtonElement>(null), cancelRef = useRef<HTMLButtonElement>(null);
  const focusAfterMove = useRef<Column | null>(null);
  const [internal, setInternal] = useState(defaultValue), [invalidAttempt, setInvalidAttempt] = useState(false);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const current = value === undefined ? internal : value;
  const selected = parseTime(current), lower = parseTime(min) ?? 0, upper = parseTime(max) ?? 1439;
  const hasRange = lower <= upper;
  const preferred = hasRange ? Math.max(lower, Math.min(upper, selected ?? 540)) : 0;
  const source = JSON.stringify([current, min, max, disabled]);
  const [interaction, setInteraction] = useState({ source, open: false, draft: preferred });
  // A new committed value, range, or disabled state invalidates an existing draft.
  if (interaction.source !== source) setInteraction({ source, open: false, draft: preferred });
  const open = interaction.open && interaction.source === source && !disabled;
  const draft = interaction.draft, hour = Math.floor(draft / 60), minute = draft % 60;
  const hourAvailable = (item: number) => hasRange && item * 60 <= upper && item * 60 + 59 >= lower;
  const minuteAvailable = (item: number) => hasRange && hour * 60 + item >= lower && hour * 60 + item <= upper;
  const validationError = current && selected === null ? "请选择有效的 24 小时时间（HH:mm）。" : !hasRange ? "当前没有可选时间，请调整时间范围。" : selected !== null && (selected < lower || selected > upper) ? `请选择 ${timeValue(lower)} 至 ${timeValue(upper)} 之间的时间。` : required && selected === null ? "请选择时间后继续。" : "";
  const errorId = `${popupId}-error`, valueId = `${popupId}-value`;
  const describedBy = [ariaDescribedBy, valueId, invalidAttempt && validationError ? errorId : ""].filter(Boolean).join(" ");

  useEffect(() => { fieldRef.current?.setCustomValidity(validationError); }, [validationError]);
  useEffect(() => {
    if (!open) return;
    revealOption(hourRef.current);
    revealOption(minuteRef.current);
    if (focusAfterMove.current) {
      (focusAfterMove.current === "hour" ? hourRef : minuteRef).current?.focus({ preventScroll: true });
      focusAfterMove.current = null;
    }
  }, [open, draft]);

  function changeOpen(next: boolean) {
    if (next && disabled) return;
    if (next) {
      setPortalContainer(triggerRef.current?.closest<HTMLElement>("dialog[open]") || null);
      focusAfterMove.current = null;
      setInteraction({ source, open: true, draft: preferred });
    } else setInteraction(previous => ({ ...previous, open: false }));
  }
  function selectPart(column: Column, part: number) {
    if (!open || disabled || !hasRange) return;
    if (column === "hour" && !hourAvailable(part) || column === "minute" && !minuteAvailable(part)) return;
    const next = column === "hour" ? Math.max(lower, Math.min(upper, part * 60 + minute)) : hour * 60 + part;
    focusAfterMove.current = column;
    setInteraction({ source, open: true, draft: next });
  }
  function optionKey(event: KeyboardEvent<HTMLButtonElement>, column: Column, part: number) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault(); event.stopPropagation();
      (event.key === "ArrowLeft" ? hourRef : minuteRef).current?.focus({ preventScroll: true });
      return;
    }
    if (!["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const items = column === "hour" ? HOURS.filter(hourAvailable) : MINUTES.filter(minuteAvailable);
    if (!items.length) return;
    const index = Math.max(0, items.indexOf(part));
    const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : event.key === "PageUp" ? -5 : 5;
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : Math.max(0, Math.min(items.length - 1, index + delta));
    selectPart(column, items[next]);
  }
  function confirm() {
    if (!open || interaction.source !== source || disabled || !hasRange || draft < lower || draft > upper) return;
    const next = timeValue(draft);
    changeOpen(false); setInvalidAttempt(false);
    if (value === undefined) setInternal(next);
    onValueChange?.(next);
  }

  return <Popover.Root open={open} onOpenChange={changeOpen} modal>
    <span className={`exp-time-field ${className}`.trim()}>
      <Popover.Trigger asChild><button ref={triggerRef} id={id} type="button" role="combobox" aria-haspopup="dialog" aria-autocomplete="none" aria-controls={popupId} aria-expanded={open} aria-label={ariaLabel} aria-describedby={describedBy} aria-required={required || undefined} aria-invalid={invalidAttempt && !!validationError || undefined} disabled={disabled} className="exp-time-trigger" data-empty={selected === null || undefined} onKeyDown={event => { if (event.key === "ArrowDown" && !open) { event.preventDefault(); changeOpen(true); } }}>
        <Clock3 size={16} aria-hidden="true"/><span>{selected === null ? placeholder : timeValue(selected)}</span><ChevronDown size={14} className="exp-time-chevron" aria-hidden="true"/>
      </button></Popover.Trigger>
      <input ref={fieldRef} name={name} form={form} type="text" className="exp-time-form-value" aria-hidden="true" tabIndex={-1} value={selected === null ? "" : timeValue(selected)} required={required} disabled={disabled} onChange={() => {}} onInvalid={event => { event.preventDefault(); setInvalidAttempt(true); triggerRef.current?.focus(); }}/>
      <span id={valueId} className="exp-time-form-value">{selected === null ? "未选择时间" : `已选北京时间 ${timeValue(selected)}`}</span>
      {invalidAttempt && validationError && <span id={errorId} className="exp-time-error" role="alert">{validationError}</span>}
    </span>
    <Popover.Portal container={portalContainer}><Popover.Content id={popupId} className="exp-time-popup" align="start" sideOffset={8} collisionPadding={16} data-exp-time-popup="" data-empty-range={!hasRange || undefined} aria-label={ariaLabel || "选择时间"} onEscapeKeyDown={event => { event.preventDefault(); event.stopPropagation(); changeOpen(false); }} onOpenAutoFocus={event => { event.preventDefault(); revealOption(hourRef.current); revealOption(minuteRef.current); (hasRange ? hourRef : cancelRef).current?.focus({ preventScroll: true }); }} onCloseAutoFocus={event => { event.preventDefault(); triggerRef.current?.focus({ preventScroll: true }); }}>
      <div className="exp-time-heading"><span><Clock3 size={14} aria-hidden="true"/>选择时间</span><small>北京时间 · 24 小时制</small></div>
      <div className="exp-time-preview" aria-live="polite"><strong>{hasRange ? timeValue(draft) : "--:--"}</strong><span>选择后确认生效</span></div>
      {hasRange ? <div className="exp-time-columns">
        <div className="exp-time-column"><div id={`${popupId}-hours`} className="exp-time-column-label">小时</div><div role="listbox" aria-labelledby={`${popupId}-hours`} className="exp-time-options">{HOURS.map(item => <button type="button" role="option" aria-selected={item === hour} aria-label={`${pad(item)} 时`} tabIndex={item === hour ? 0 : -1} ref={item === hour ? hourRef : undefined} key={item} disabled={disabled || !hourAvailable(item)} className="exp-time-option" onClick={() => selectPart("hour", item)} onKeyDown={event => optionKey(event, "hour", item)}><span>{pad(item)}</span>{item === hour && <Check size={13} aria-hidden="true"/>}</button>)}</div></div>
        <span className="exp-time-separator" aria-hidden="true">:</span>
        <div className="exp-time-column"><div id={`${popupId}-minutes`} className="exp-time-column-label">分钟</div><div role="listbox" aria-labelledby={`${popupId}-minutes`} className="exp-time-options">{MINUTES.map(item => <button type="button" role="option" aria-selected={item === minute} aria-label={`${pad(item)} 分`} tabIndex={item === minute ? 0 : -1} ref={item === minute ? minuteRef : undefined} key={item} disabled={disabled || !minuteAvailable(item)} className="exp-time-option" onClick={() => selectPart("minute", item)} onKeyDown={event => optionKey(event, "minute", item)}><span>{pad(item)}</span>{item === minute && <Check size={13} aria-hidden="true"/>}</button>)}</div></div>
      </div> : <p className="exp-time-range-empty" role="status">当前范围没有可选时间，请先调整时间限制。</p>}
      <div className="exp-time-footer"><span>{min || max ? hasRange ? `${timeValue(lower)} – ${timeValue(upper)}` : "无可选范围" : "支持方向键选择"}</span><button ref={cancelRef} type="button" onClick={() => changeOpen(false)}>取消</button><button type="button" className="exp-time-confirm" disabled={disabled || !hasRange} onClick={confirm}>确认<Check size={12} aria-hidden="true"/></button></div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
