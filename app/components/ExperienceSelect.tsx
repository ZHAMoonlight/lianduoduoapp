"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronUp, ListFilter } from "lucide-react";
import { Select } from "radix-ui";
import "./experience-select.css";

export interface ExperienceSelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface ExperienceSelectProps {
  name?: string;
  id?: string;
  form?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  options: ExperienceSelectOption[];
  placeholder?: string;
  emptyMessage?: string;
  menuLabel?: string;
  disabled?: boolean;
  required?: boolean;
  icon?: ReactNode;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

/** Form-compatible, keyboard-accessible choice field shared by admin forms. */
export function ExperienceSelect({
  name, id, form, value, defaultValue = "", onValueChange, options,
  placeholder = "请选择", emptyMessage = "暂无可选项", menuLabel,
  disabled = false, required = false, icon, className = "",
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: ExperienceSelectProps) {
  const descriptionId = useId();
  const emptyValue = `exp-empty-${descriptionId}`;
  const trigger = useRef<HTMLButtonElement>(null), field = useRef<HTMLInputElement>(null);
  const [internal, setInternal] = useState(defaultValue), [open, setOpen] = useState(false);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const [invalidAttempt, setInvalidAttempt] = useState(false);
  const current = value === undefined ? internal : value;
  const selected = options.find(option => option.value === current);
  const error = required && !current ? "请选择后继续。" : current && (!selected || selected.disabled) ? "原选项已不可用，请重新选择。" : "";
  const errorId = `${descriptionId}-error`;
  useEffect(() => { field.current?.setCustomValidity(error); }, [error]);
  function choose(next: string) {
    const nextValue = next === emptyValue ? "" : next;
    if (value === undefined) setInternal(nextValue);
    setInvalidAttempt(false); onValueChange?.(nextValue);
  }
  function changeOpen(next: boolean) {
    if (next) setPortalContainer(trigger.current?.closest<HTMLElement>("dialog[open]") || null);
    setOpen(next);
  }
  return <Select.Root value={selected ? current || emptyValue : ""} onValueChange={choose} open={open} onOpenChange={changeOpen} disabled={disabled}>
    <span className="exp-choice-field">
    <Select.Trigger
      ref={trigger}
      id={id}
      className={`exp-choice-trigger ${className}`.trim()}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={[ariaDescribedBy, invalidAttempt && error ? errorId : ""].filter(Boolean).join(" ") || undefined}
      aria-invalid={ariaInvalid || invalidAttempt && !!error || undefined}
      aria-required={required || undefined}
    >
      {icon && <span className="exp-choice-leading" aria-hidden="true">{icon}</span>}
      <Select.Value className="exp-choice-value" placeholder={placeholder}/>
      <Select.Icon className="exp-choice-chevron" asChild><ChevronDown size={16}/></Select.Icon>
    </Select.Trigger>
    <input ref={field} name={name} form={form} type="text" className="exp-choice-form-value" aria-hidden="true" tabIndex={-1} value={current} required={required} disabled={disabled} onChange={() => {}} onInvalid={event => { event.preventDefault(); setInvalidAttempt(true); trigger.current?.focus(); }}/>
    {invalidAttempt && error && <span id={errorId} className="exp-choice-error" role="alert">{error}</span>}
    </span>
    <Select.Portal container={portalContainer}>
      <Select.Content
        position="popper"
        align="start"
        sideOffset={7}
        collisionPadding={16}
        className="exp-choice-popup"
        data-exp-select-popup=""
        onEscapeKeyDown={event => event.stopPropagation()}
      >
        <Select.ScrollUpButton className="exp-choice-scroll"><ChevronUp size={14}/></Select.ScrollUpButton>
        <Select.Viewport className="exp-choice-viewport">
          <Select.Group>
            {menuLabel && <Select.Label className="exp-choice-menu-label">{menuLabel}</Select.Label>}
            {options.length ? options.map((option, index) => <Select.Item key={option.value} value={option.value || emptyValue} textValue={option.label} disabled={option.disabled} aria-describedby={option.description ? `${descriptionId}-${index}` : undefined} className="exp-choice-item">
              <span className="exp-choice-item-copy">
                <Select.ItemText className="exp-choice-item-label">{option.label}</Select.ItemText>
                {option.description && <span id={`${descriptionId}-${index}`} className="exp-choice-item-description">{option.description}</span>}
              </span>
              <span className="exp-choice-item-check"><Select.ItemIndicator><Check size={15}/></Select.ItemIndicator></span>
            </Select.Item>) : <div className="exp-choice-empty" role="status"><ListFilter size={20}/><span>{emptyMessage}</span></div>}
          </Select.Group>
        </Select.Viewport>
        <Select.ScrollDownButton className="exp-choice-scroll"><ChevronDown size={14}/></Select.ScrollDownButton>
      </Select.Content>
    </Select.Portal>
  </Select.Root>;
}
