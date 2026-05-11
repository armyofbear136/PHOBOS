# Home Assistant Automation Generator

Generate valid, copy-paste-ready Home Assistant automation YAML from natural language.
Output is always for the user to review and paste into HA — never executed by PHOBOS directly.

---

## Entity Awareness

When a Home Assistant snapshot is present in context (the `## HOME ASSISTANT — LIVE STATE` block),
always use the **exact entity IDs** from that snapshot. Never invent entity IDs.

If no snapshot is present, use placeholder IDs in the format `domain.descriptive_name` and
add a comment at the top of the YAML:

```yaml
# NOTE: Replace entity IDs with your actual HA entity IDs.
# Connect Home Assistant in PHOBOS (Cybernetics > Home Assistant) for automatic entity resolution.
```

---

## Automation Structure

Every automation is a single YAML document. Always include all required top-level keys.

```yaml
alias: Human-readable name for the automation
description: Optional — what this automation does
trigger:
  - ...
condition:          # Optional — omit if no conditions needed
  - ...
action:
  - ...
mode: single        # single | restart | queued | parallel
```

### `mode` values
| Mode | Use when |
|------|----------|
| `single` | Default. Ignore new triggers if already running. |
| `restart` | Cancel current run and restart on new trigger. |
| `queued` | Queue new triggers, run in order. |
| `parallel` | Allow multiple simultaneous runs. |

---

## Triggers

### State trigger — entity changes state
```yaml
trigger:
  - platform: state
    entity_id: light.living_room
    to: "off"
    for:
      minutes: 5      # Optional: only fire after state held for duration
```

### Time trigger — fires at a specific time
```yaml
trigger:
  - platform: time
    at: "22:30:00"
```

### Time pattern — fires on a recurring schedule
```yaml
trigger:
  - platform: time_pattern
    hours: "/1"       # Every hour
    minutes: "0"
    # hours: "22"     # Specific hour
    # minutes: "/30"  # Every 30 minutes
```

### Sun trigger — sunrise/sunset with optional offset
```yaml
trigger:
  - platform: sun
    event: sunset
    offset: "-00:30:00"   # 30 minutes before sunset
```

### Numeric state trigger — sensor crosses a threshold
```yaml
trigger:
  - platform: numeric_state
    entity_id: sensor.living_room_temperature
    above: 78
    # below: 60
    # for: { minutes: 10 }
```

### Template trigger — arbitrary Jinja2 condition becomes true
```yaml
trigger:
  - platform: template
    value_template: >
      {{ states('sensor.outside_temp') | float < 32
         and is_state('climate.main', 'off') }}
```

### Multiple triggers — any one fires the automation
```yaml
trigger:
  - platform: state
    entity_id: binary_sensor.front_door
    to: "on"
  - platform: time
    at: "08:00:00"
```

---

## Conditions

Conditions are evaluated after the trigger. The automation only proceeds if all conditions pass.

### State condition
```yaml
condition:
  - condition: state
    entity_id: person.john
    state: home
```

### Time condition — only run during a window
```yaml
condition:
  - condition: time
    after: "07:00:00"
    before: "23:00:00"
    weekday:              # Optional
      - mon
      - tue
      - wed
      - thu
      - fri
```

### Numeric state condition
```yaml
condition:
  - condition: numeric_state
    entity_id: sensor.living_room_lux
    below: 200
```

### Template condition
```yaml
condition:
  - condition: template
    value_template: >
      {{ states('sun.sun') == 'below_horizon' }}
```

### AND / OR / NOT logic
```yaml
condition:
  - condition: and
    conditions:
      - condition: state
        entity_id: input_boolean.guest_mode
        state: "off"
      - condition: time
        after: "22:00:00"
        before: "07:00:00"
```

---

## Actions

### Turn on / off / toggle
```yaml
action:
  - service: light.turn_on
    target:
      entity_id: light.bedroom
    data:
      brightness_pct: 50
      color_temp: 400     # Mireds — lower = cooler

  - service: light.turn_off
    target:
      entity_id:
        - light.living_room
        - light.kitchen

  - service: switch.toggle
    target:
      entity_id: switch.garden_sprinkler
```

### Climate control
```yaml
action:
  - service: climate.set_temperature
    target:
      entity_id: climate.main
    data:
      temperature: 70
      hvac_mode: heat     # heat | cool | heat_cool | auto | off
```

### Lock / unlock
```yaml
action:
  - service: lock.lock
    target:
      entity_id: lock.front_door

  - service: lock.unlock
    target:
      entity_id: lock.front_door
```

### Cover (blinds, garage doors)
```yaml
action:
  - service: cover.open_cover
    target:
      entity_id: cover.garage_door

  - service: cover.set_cover_position
    target:
      entity_id: cover.living_room_blinds
    data:
      position: 50    # 0 = closed, 100 = fully open
```

### Media player
```yaml
action:
  - service: media_player.volume_set
    target:
      entity_id: media_player.living_room_speaker
    data:
      volume_level: 0.3   # 0.0–1.0

  - service: media_player.media_pause
    target:
      entity_id: media_player.bedroom_tv
```

### Notifications
```yaml
action:
  - service: notify.mobile_app_phone      # Replace with actual notify target
    data:
      title: "Front door"
      message: "Front door left open for 10 minutes"
```

### Input helpers
```yaml
action:
  - service: input_boolean.turn_on
    target:
      entity_id: input_boolean.away_mode

  - service: input_number.set_value
    target:
      entity_id: input_number.alarm_volume
    data:
      value: 75
```

### Delays and waits
```yaml
action:
  - delay:
      minutes: 5

  - wait_template: >
      {{ is_state('binary_sensor.motion_bedroom', 'off') }}
    timeout:
      minutes: 10
    continue_on_timeout: true
```

### Scenes
```yaml
action:
  - service: scene.turn_on
    target:
      entity_id: scene.movie_time
```

### Scripts
```yaml
action:
  - service: script.good_morning_routine
```

### Choose — conditional branching within actions
```yaml
action:
  - choose:
      - conditions:
          - condition: time
            after: "07:00:00"
            before: "22:00:00"
        sequence:
          - service: light.turn_on
            target:
              entity_id: light.hallway
            data:
              brightness_pct: 100
      - conditions:
          - condition: time
            after: "22:00:00"
        sequence:
          - service: light.turn_on
            target:
              entity_id: light.hallway
            data:
              brightness_pct: 10
    default:
      - service: light.turn_on
        target:
          entity_id: light.hallway
```

### Repeat — loop an action
```yaml
action:
  - repeat:
      count: 3
      sequence:
        - service: notify.mobile_app_phone
          data:
            message: "Alert!"
        - delay:
            seconds: 30
```

---

## Jinja2 Template Reference

Templates are used inside `value_template`, `data_template`, and `message` fields.

```jinja
{# Get an entity's state #}
{{ states('sensor.temperature') }}
{{ states('sensor.temperature') | float }}
{{ states('sensor.temperature') | int }}

{# Check state #}
{{ is_state('binary_sensor.door', 'on') }}

{# Get an attribute #}
{{ state_attr('light.living_room', 'brightness') }}
{{ state_attr('climate.main', 'current_temperature') }}

{# Time and dates #}
{{ now().hour }}
{{ now().strftime('%H:%M') }}
{{ as_timestamp(now()) | timestamp_custom('%A') }}  {# Day name #}

{# Conditional logic #}
{{ 'on' if states('switch.fan') == 'on' else 'off' }}

{# Math #}
{{ (states('sensor.temp_f') | float - 32) * 5 / 9 | round(1) }}
```

---

## Common Patterns

### Turn off lights when no motion for N minutes
```yaml
alias: "Auto-off: Living Room after 10 min no motion"
trigger:
  - platform: state
    entity_id: binary_sensor.living_room_motion
    to: "off"
    for:
      minutes: 10
condition:
  - condition: state
    entity_id: light.living_room
    state: "on"
action:
  - service: light.turn_off
    target:
      entity_id: light.living_room
mode: single
```

### Good morning routine triggered by time + person home
```yaml
alias: "Good Morning Routine"
trigger:
  - platform: time
    at: "07:00:00"
condition:
  - condition: state
    entity_id: person.resident
    state: home
action:
  - service: light.turn_on
    target:
      entity_id: light.bedroom
    data:
      brightness_pct: 30
      color_temp: 500
  - delay:
      minutes: 10
  - service: light.turn_on
    target:
      entity_id: light.kitchen
    data:
      brightness_pct: 100
mode: single
```

### Lock doors at night
```yaml
alias: "Night Lock: All Exterior Doors"
trigger:
  - platform: time
    at: "23:00:00"
action:
  - service: lock.lock
    target:
      entity_id:
        - lock.front_door
        - lock.back_door
  - service: notify.mobile_app_phone
    data:
      message: "All doors locked for the night."
mode: single
```

### Alert when window left open during rain
```yaml
alias: "Rain Alert: Window Open"
trigger:
  - platform: state
    entity_id: sensor.weather_condition
    to: "rainy"
condition:
  - condition: state
    entity_id: binary_sensor.bedroom_window
    state: "on"   # open
action:
  - service: notify.mobile_app_phone
    data:
      title: "Rain warning"
      message: "Bedroom window is open and it's raining."
mode: single
```

### Dim lights at sunset
```yaml
alias: "Sunset Dimming"
trigger:
  - platform: sun
    event: sunset
    offset: "00:00:00"
action:
  - service: light.turn_on
    target:
      entity_id: light.living_room
    data:
      brightness_pct: 60
      transition: 600   # 10 minute transition in seconds
mode: single
```

---

## Output Format Rules

1. Always output a complete, standalone YAML block — no partial snippets unless the user explicitly asks to modify one section.
2. Add an `alias` that clearly describes what the automation does.
3. Add `description` when the automation is complex or non-obvious.
4. If referencing entity IDs from the live snapshot, use them verbatim.
5. Add inline YAML comments (`# ...`) to explain non-obvious choices — thresholds, delays, template logic.
6. After the YAML block, add a brief plain-English summary of what the automation does and any assumptions made.
7. If the user's request is ambiguous (e.g. "turn off lights at night" — which lights? which time?), state your assumptions explicitly and offer to revise.
8. If HA is not connected and no entity IDs are available, note the placeholder pattern and suggest connecting HA in PHOBOS for automatic resolution.

---

## Pasting into Home Assistant

Remind the user how to use the output:

> **To use this automation:**
> 1. In Home Assistant, go to **Settings → Automations & Scenes → Automations**
> 2. Click **Create Automation → Create new automation**
> 3. Click the three-dot menu (⋮) → **Edit in YAML**
> 4. Paste the YAML above
> 5. Click **Save**

Or via `automations.yaml` (if using manual YAML config):
Add the block to `config/automations.yaml` and call `service: automation.reload`.
