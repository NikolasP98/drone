// Reference streaming drone: extract named entities from free text.
// Demonstrates the canonical Stream<T> pattern — fields materialize
// incrementally as the model generates output.

class Entity {
  name string
  kind EntityKind
  mentions int @description("number of times the entity appears in the source text")
}

enum EntityKind {
  PERSON
  PLACE
  ORG
  CONCEPT
  OTHER
}

class EntityExtraction {
  entities Entity[]
  summary string @description("one-sentence summary of what the text is about")
}

function ExtractEntities(text: string) -> EntityExtraction {
  client ClaudeSonnet
  prompt #"
    Extract every named entity from the text below. For each entity, classify
    it and count how many times it appears. Then produce a one-sentence summary.

    {{ ctx.output_format }}

    Text:
    {{ text }}
  "#
}

test ExtractEntitiesShort {
  functions [ExtractEntities]
  args {
    text "Niko and Renzo started Minion. Niko writes the code; Renzo runs ops from Buenos Aires."
  }
  @@assert(has_niko, {{ this.entities|selectattr("name", "equalto", "Niko")|list|length == 1 }})
  @@assert(has_buenos_aires, {{ this.entities|selectattr("name", "equalto", "Buenos Aires")|list|length == 1 }})
}
