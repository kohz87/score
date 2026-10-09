-- Models the pickers show by default (5.31). Empty = show every model. Score-side only; Hermes never reads it.
CREATE TABLE model_visibility (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  PRIMARY KEY (provider, model)
);
