# Jeu de données pour la phase 5

## Produire le fichier

```bash
npm run export                      # toutes les parties terminées
npm run export -- --top4            # uniquement les parties de top 4
npm run export -- --out autre.jsonl
```

Sortie : `data/export/decisions.jsonl`, une décision par ligne au format
[JSON Lines](https://jsonlines.org/). Ce format plutôt que du CSV parce que
chaque décision porte trois listes de longueur variable (plateau, main,
boutique) qu'un tableau plat ne peut pas représenter sans les éclater.

## Charger

```python
import pandas as pd

d = pd.read_json("data/export/decisions.jsonl", lines=True)
```

## Colonnes

| Colonne | Contenu |
|---|---|
| `gameId` | identifiant stable de la partie |
| `finalPlace`, `top4`, `ratingAfter` | **l'issue** : les étiquettes d'apprentissage |
| `heroCardId`, `startedAt` | contexte de la partie |
| `sequence`, `turn` | position de la décision |
| `action` | `buy`, `buySpell`, `sell`, `reroll`, `freeze`, `tierUp`, `heroPower`, `play` |
| `targetCardId` | la carte retenue : **c'est la cible à prédire** |
| `position` | emplacement de pose |
| `gold`, `tavernTier`, `health` | état du joueur |
| `board`, `hand`, `shop` | ce qu'il avait sous les yeux |

Chaque carte de `board` / `hand` / `shop` porte `cardId`, `name`, `techLevel`,
`races`, `position`, `atk`, `health`, `golden`.

## ⚠️ Imiter n'est pas conseiller

Un modèle entraîné sur **toutes** les parties apprend à prédire *ce que le
joueur ferait* — ses erreurs comprises. Il recommanderait ses propres mauvaises
habitudes.

Pour qu'il conseille au lieu d'imiter, n'entraîner que sur les parties
réussies :

```python
bonnes = d[d.top4]
```

ou pondérer par la place finale. L'écart entre ce que le modèle propose et ce
que le joueur a réellement fait devient alors le signal « ici tu as dévié de
ton meilleur jeu ».

**Plafond à garder en tête** : ces données ne contiennent que des coups que le
joueur a joués. Un modèle appris dessus ne découvrira jamais une stratégie
qu'il n'a jamais essayée.

## Exemple : les achats comme des choix

```python
achats = d[(d.action == "buy") & d.top4 & d.targetCardId.notna()].copy()

# Palier de la carte prise, et plus haut palier qui était proposé.
achats["pris"] = achats.apply(
    lambda r: next((c["techLevel"] for c in r.shop if c["cardId"] == r.targetCardId), None),
    axis=1,
)
achats["dispo_max"] = achats.shop.apply(
    lambda s: max([c["techLevel"] for c in s if c["techLevel"]], default=None)
)

t = achats.dropna(subset=["pris", "dispo_max"])
print(f"prend le plus haut palier disponible : {100 * (t.pris == t.dispo_max).mean():.0f} %")
```

## Volume

Le prérequis de la phase 5 est *plusieurs centaines de parties*. À titre de
repère, 28 parties donnent environ 4 500 décisions et 50 000 cartes visibles.
Les modèles supervisés attendent ce volume ; l'export, lui, fonctionne dès
maintenant.
