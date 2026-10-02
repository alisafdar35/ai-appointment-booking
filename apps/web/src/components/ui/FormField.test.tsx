import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FormField } from './FormField';
import { Input } from './Input';
import { Select } from './Select';
import { Textarea } from './Textarea';

describe('FormField', () => {
  it('binds the label to the control', () => {
    render(
      <FormField label="Email">
        <Input type="email" />
      </FormField>,
    );
    expect(screen.getByLabelText('Email')).toBeInstanceOf(HTMLInputElement);
  });

  it('describes the control by its hint and marks it valid when there is no error', () => {
    render(
      <FormField label="Phone" hint="Include the country code">
        <Input />
      </FormField>,
    );
    const input = screen.getByLabelText('Phone');
    expect(input).toHaveAccessibleDescription('Include the country code');
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('marks the control invalid and describes it by hint AND error', () => {
    render(
      <FormField label="Phone" hint="Include the country code" error="Enter a valid phone number">
        <Input />
      </FormField>,
    );
    const input = screen.getByLabelText('Phone');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Include the country code Enter a valid phone number');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid phone number');
  });

  it('flags required fields for assistive tech without relying on native validation', () => {
    render(
      <FormField label="Name" required>
        <Input />
      </FormField>,
    );
    expect(screen.getByLabelText(/Name/)).toHaveAttribute('aria-required', 'true');
    expect(screen.getByLabelText(/Name/)).not.toHaveAttribute('required');
  });

  it('wires Textarea and Select the same way', () => {
    render(
      <>
        <FormField label="Notes" error="Too long">
          <Textarea />
        </FormField>
        <FormField label="Service" hint="Pick one">
          <Select>
            <option>Cleaning</option>
          </Select>
        </FormField>
      </>,
    );
    expect(screen.getByLabelText('Notes')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Notes')).toHaveAccessibleDescription('Too long');
    expect(screen.getByLabelText('Service')).toHaveAccessibleDescription('Pick one');
  });

  it('keeps a caller-supplied aria-describedby alongside its own', () => {
    render(
      <>
        <p id="extra">Extra help</p>
        <FormField label="Code" hint="Six digits">
          <Input aria-describedby="extra" />
        </FormField>
      </>,
    );
    expect(screen.getByLabelText('Code')).toHaveAccessibleDescription('Extra help Six digits');
  });

  it('gives each field its own ids', () => {
    render(
      <>
        <FormField label="A">
          <Input />
        </FormField>
        <FormField label="B">
          <Input />
        </FormField>
      </>,
    );
    expect(screen.getByLabelText('A').id).not.toBe(screen.getByLabelText('B').id);
  });
});
