import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Tab, TabList, TabPanel, Tabs } from './Tabs';

function Harness() {
  const [value, setValue] = useState('upcoming');
  return (
    <Tabs value={value} onValueChange={setValue}>
      <TabList label="Appointment filters">
        <Tab value="upcoming">Upcoming</Tab>
        <Tab value="past">Past</Tab>
        <Tab value="cancelled" disabled>
          Cancelled
        </Tab>
        <Tab value="all">All</Tab>
      </TabList>
      <TabPanel value="upcoming">Upcoming list</TabPanel>
      <TabPanel value="past">Past list</TabPanel>
      <TabPanel value="cancelled">Cancelled list</TabPanel>
      <TabPanel value="all">Everything</TabPanel>
    </Tabs>
  );
}

describe('Tabs', () => {
  it('exposes tablist semantics and wires each tab to its panel', () => {
    render(<Harness />);
    expect(screen.getByRole('tablist', { name: 'Appointment filters' })).toBeInTheDocument();

    const upcoming = screen.getByRole('tab', { name: 'Upcoming' });
    expect(upcoming).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Past' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tabpanel', { name: 'Upcoming' })).toHaveTextContent('Upcoming list');
    expect(upcoming.getAttribute('aria-controls')).toBe(screen.getByRole('tabpanel', { name: 'Upcoming' }).id);
  });

  it('uses a roving tabindex: only the selected tab is a Tab stop', () => {
    render(<Harness />);
    expect(screen.getByRole('tab', { name: 'Upcoming' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Past' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('tabindex', '-1');
  });

  it('moves focus and selection with the arrow keys, skipping disabled tabs and wrapping', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole('tab', { name: 'Upcoming' }).focus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Past' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Past' })).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowRight}'); // skips the disabled "Cancelled"
    expect(screen.getByRole('tab', { name: 'All' })).toHaveFocus();

    await user.keyboard('{ArrowRight}'); // wraps to the first
    expect(screen.getByRole('tab', { name: 'Upcoming' })).toHaveFocus();

    await user.keyboard('{ArrowLeft}'); // wraps to the last
    expect(screen.getByRole('tab', { name: 'All' })).toHaveFocus();
  });

  it('supports Home and End', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole('tab', { name: 'Upcoming' }).focus();

    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'All' })).toHaveFocus();
    expect(screen.getByRole('tabpanel', { name: 'All' })).toHaveTextContent('Everything');

    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Upcoming' })).toHaveFocus();
  });

  it('renders panel content only for the selected tab', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByText('Past list')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Past' }));

    expect(screen.getByText('Past list')).toBeInTheDocument();
    expect(screen.queryByText('Upcoming list')).not.toBeInTheDocument();
  });
});
