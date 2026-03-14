# Prompt Scenario Tests

These scenarios are designed to test whether Schizm can take a stream of fragmented prompts that feel only loosely related at first, then gradually organize them into a more coherent set of notes and a more connected `main.canvas`.

The point is not to test factual correctness. The point is to test convergence:

- early prompts should create a few separate notes or weakly linked clusters
- later prompts should reveal deeper common themes
- the agent should reorganize the notes to reflect those themes
- the canvas should move from scattered islands toward a clearer shape

## How To Use These

Run each scenario as a sequence of separate prompts, in order.

After rounds `2`, `4`, and the final round, inspect:

- `obsidian-repository/` for how the notes were grouped, merged, renamed, or linked
- `obsidian-repository/main.canvas` for whether the concept map became more coherent
- `obsidian-repository/audit.md` for whether the rationale matches the visible reorganization

## What Good Looks Like

A strong run should show:

- minimal premature merging in the first few rounds
- stronger clustering once a repeated underlying theme becomes visible
- note names becoming more conceptually precise over time
- canvas nodes moving from isolated fragments to related neighborhoods
- no invented ideas beyond what the prompts actually imply

Red flags:

- every prompt becomes its own permanent note with no later consolidation
- the agent forces a unifying theory too early
- the agent adds interpretations that were not in the prompts
- the canvas remains visually flat even after strong conceptual overlap emerges

## Scenario 1: Sensory Load Pattern

### Goal

Test whether mundane complaints eventually collapse into a coherent picture about sensory regulation and thinking.

### Prompt Sequence

1. `I keep meaning to buy softer light bulbs for my apartment.`
2. `Coffee shops are only usable for me until the grinder starts going every few minutes.`
3. `I do some of my clearest thinking in parking lots late at night after stores close.`
4. `I get weirdly irritable in big grocery stores even when nothing bad is happening.`
5. `It might be that I am always trying to lower the amount of input around me before I can think clearly.`
6. `Maybe a lot of what I call mood is actually noise, brightness, and crowding.`

### Expected Evolution

- Early rounds may create separate notes around lighting, noisy public spaces, and quiet environments.
- By rounds `4` to `6`, those ideas should start clustering into a note about sensory load, overstimulation, or environmental regulation.
- Earlier narrow notes may stay as child notes, be merged, or be reframed under a broader concept.

### Expected Canvas Shape

- Round `1` to `2`: two or three weakly related nodes.
- Round `3` to `4`: a visible cluster around environment and cognition.
- Round `5` to `6`: one stronger central node with linked subtopics like light, noise, crowds, and clear thinking.

## Scenario 2: Avoidance, Money, and Visibility

### Goal

Test whether scattered admin frustrations eventually resolve into a single pattern around being seen, evaluated, and paid.

### Prompt Sequence

1. `I let finished invoices sit unsent for days even when I need the money.`
2. `Following up on emails feels way more intense than it should.`
3. `I can explain work well out loud, but packaging it into something sendable makes me freeze.`
4. `Asking to be paid always feels a little like being pushy even when I earned it.`
5. `A lot of my unfinished freelance admin might really be avoidance of being perceived.`
6. `I think money tasks and visibility tasks are getting tangled together in my head.`

### Expected Evolution

- Early notes may look unrelated: invoices, email follow-up, packaging work.
- Later prompts should justify a stronger note around visibility anxiety, self-presentation, or payment friction.
- Narrower notes may remain, but the repository should show that they belong to the same underlying pattern.

### Expected Canvas Shape

- Round `1` to `3`: small disconnected work-admin nodes.
- Round `4` to `5`: links begin forming between money, exposure, and communication.
- Final round: a central note tying together invoices, follow-up, being seen, and avoidance.

## Scenario 3: Objects as Memory Anchors

### Goal

Test whether random behaviors around physical objects gradually resolve into a grief or memory-preservation pattern.

### Prompt Sequence

1. `I leave receipts in books and jackets for months and never really mean to clean them out.`
2. `I have a hard time throwing away anything with someone's handwriting on it.`
3. `Certain hardware stores make me sad in a way that takes me a second to understand.`
4. `I think part of my apartment is arranged around not losing traces of people.`
5. `Objects might be doing memory work for me that I do not know how to do directly.`
6. `Maybe keeping clutter is sometimes me refusing to let certain people disappear completely.`

### Expected Evolution

- The first prompts may create notes about clutter, handwriting, or place-based sadness.
- Later rounds should reveal that these are not independent habits, but expressions of memory preservation and grief.
- The final structure should feel tighter and more emotionally legible without adding therapy-language that was never present.

### Expected Canvas Shape

- Early rounds: object-related notes with weak links.
- Mid rounds: a bridge appears between clutter, handwriting, and place-triggered emotion.
- Final round: a coherent cluster around traces, memory, and not letting things disappear.

## Scenario 4: Fragment Capture Becomes a System Need

### Goal

Test whether disconnected comments about capture habits turn into a coherent description of the kind of knowledge system the user actually wants.

### Prompt Sequence

1. `I want a place for random fragments that are too small to deserve full notes yet.`
2. `Voice notes work better than typing when I am walking.`
3. `I remember things better when I can place them spatially.`
4. `A lot of ideas die because they never end up near the other ideas they belong beside.`
5. `Maybe I do not want a notes app as much as a thing that keeps finding the right neighbors for my thoughts.`
6. `I think the real need is a system that keeps small fragments alive long enough to become part of something bigger.`

### Expected Evolution

- Early prompts may produce notes around fragments, voice capture, and spatial memory.
- Later prompts should justify a more central note around thought capture, adjacency, or a living note system.
- This scenario is especially good for seeing whether the repo can form a product-shaped concept from initially scattered preferences.

### Expected Canvas Shape

- Round `1` to `2`: intake-related notes.
- Round `3` to `4`: more visible links between spatial memory and idea survival.
- Final round: a central system-design node with spokes for fragments, voice, spatial placement, and neighboring ideas.

## Scenario 5: Social Energy, Not Introversion

### Goal

Test whether surface-level social preferences eventually resolve into a more specific energy-management pattern.

### Prompt Sequence

1. `I like seeing people, but I almost always want a fixed ending time.`
2. `Group dinners are harder for me than walking with one person.`
3. `I can be fully engaged socially and still feel like I need silence immediately afterward.`
4. `It is not exactly that I dislike being around people.`
5. `I think what drains me is managing multiple signals at once while still being readable to everyone there.`
6. `Maybe I keep calling this introversion when it is actually bandwidth management.`

### Expected Evolution

- Early notes may center on group settings, one-on-one interaction, and recovery after socializing.
- Later prompts should allow those to converge into a better-framed note about social bandwidth or signal load.
- The resulting structure should replace an overly generic framing with a more precise one.

### Expected Canvas Shape

- Early rounds: social preference fragments.
- Mid rounds: a bridge between group size, signal complexity, and recovery needs.
- Final round: a stronger center node with supporting subtopics for endings, one-on-one interaction, and decompression.

## Suggested Evaluation Checklist

Use this after each full scenario:

- Did the agent avoid inventing meaning too early?
- Did the later prompts cause visible restructuring, not just appending?
- Did note titles become more precise as the pattern emerged?
- Did the final canvas show clusters and bridges instead of a flat list of nodes?
- Did the final result feel like a clearer version of the same ideas rather than a more elaborate theory?
