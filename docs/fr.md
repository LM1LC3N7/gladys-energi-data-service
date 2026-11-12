# Energi Data Service (Danemark)

Intégration non officielle. Elle tarifie votre électricité au Danemark sous
forme de **contrat d’énergie** Gladys : le tarif réseau horaire de votre
gestionnaire (netselskab), les tarifs de transport et de système
d’Energinet, la taxe sur l’électricité (elafgift) et, si vous le voulez, le
prix spot DK1/DK2 avec la marge de votre fournisseur, TVA 25 % comprise. Tout
vient d’**Energi Data Service**, le portail de données ouvertes d’Energinet,
sans compte ni clé.

Elle n’a jamais été testée avec un vrai contrat Gladys ni un vrai compteur
danois : les prix sont vérifiés par les tests sur de vraies réponses de
l’API. Signalez toute différence avec votre facture.

## Mise en place

1. Installez l’intégration (Gladys 5.3.0 ou plus). Rien à remplir dans son
   écran de configuration.
2. Dans **Énergie > Contrats**, créez un contrat avec le modèle
   **« Energi Data Service (Danemark) : tarifs et spot »** et rattachez votre
   compteur :
   - **Gestionnaire de réseau** : son nom (« Radius », « N1 A/S - 131 ») ou
     son GLN (13 caractères, sur votre facture). La liste est plus bas.
   - **Code du tarif** : laissez vide, sauf si le statut le demande.
   - **Fourniture** : `grid_only` (tarifs et elafgift seuls) ou `spot` (plus
     le prix spot au quart d’heure et la marge du fournisseur).
   - **Zone de prix** (obligatoire pour `spot`, sans valeur par défaut) :
     `DK1` à l’ouest du Grand Belt (Jutland, Fionie), `DK2` à l’est (Seeland,
     Lolland-Falster, Bornholm).
   - **Marge du fournisseur** (DKK/kWh hors TVA, entre -1 et 5) : le
     « tillæg » de votre fournisseur, ajouté au prix spot.
   - **Abonnements mensuels** (DKK/mois, TVA comprise) : abonnement réseau,
     celui d’Energinet et celui du fournisseur, comptés par Gladys comme un
     montant fixe mensuel. Ils ne sont pas lus dans DataHub.
3. Un appareil « Elpris <gestionnaire> » apparaît dans **Découverte** : il
   affiche le prix actuel d’un kWh (DKK/kWh, TVA comprise).

L’API accepte environ **une requête par minute** : l’intégration demande une
chose à la fois, à 65 secondes d’écart au moins. Après la création d’un
contrat, ses prix arrivent en quelques minutes (tarifs d’Energinet, puis
ceux du gestionnaire, puis les prix spot). D’ici là, Gladys ne reçoit aucun
coût pour les intervalles et redemande au passage suivant (jamais un zéro).

## Calcul du prix

Pour chaque demi-heure, en DKK, TVA comprise :

    kWh × (tarif réseau de l’heure locale + tarif de transport + tarif de
           système + elafgift + [prix spot + marge]) × 1,25

- **Tarif réseau** : le tarif résidentiel (« Nettarif C ») du gestionnaire,
  par heure locale (Price1 = 00:00-01:00 heure danoise). La nuit du
  changement d’heure d’automne, l’heure 02:00 a lieu deux fois : les deux
  prennent le même prix, comme l’indique Energinet ; au printemps elle
  n’existe pas.
- **Energinet** : tarif de transport (code 40000), tarif de système (41000)
  et elafgift (EA-001), par jour.
- **Spot** : DayAheadPrices de la zone, prix au quart d’heure (depuis le
  1er octobre 2025), moyenne des deux quarts d’heure de la demi-heure (Gladys
  envoie des relevés à la demi-heure : la consommation y est supposée
  régulière).
- Gestionnaire avec plusieurs codes de tarif résidentiel (« NT-01 »,
  « NT-10 »…) : s’ils donnent le même prix, il est utilisé ; s’ils diffèrent,
  le statut demande le **Code du tarif** et cite les choix.

Ce que Gladys ne sait pas exprimer, dit clairement :

- Un **total négatif** (prix spot très négatif) coûte **zéro** : Gladys ne
  prend pas de crédit pour un intervalle. Le « prix actuel » de l’appareil
  peut être négatif.
- Pas d’elafgift réduite (elvarme) ni de règles de TVA d’entreprise : les
  prix résidentiels.
- Pas de prix spot avant le 1er octobre 2025 (début du jeu au quart d’heure).
- Les abonnements sont une saisie mensuelle de votre part.

Un prix inconnu (tarifs pas encore lus, pas de tarif pour cette date, quart
d’heure de spot manquant) n’est jamais deviné ni compté zéro : l’intervalle
n’a pas de coût et Gladys redemande.

## Données et requêtes

- Tarifs : jeu **DatahubPricelist**, lu pour les gestionnaires de vos
  contrats et pour Energinet, puis **une fois par jour** (une lecture en échec
  est retentée après une heure ; les tarifs détenus restent utilisés, et le
  statut signale quand ils n’ont pas été relus depuis 3 jours). Gardés dans
  /data.
- Prix spot : jeu **DayAheadPrices**, ceux du jour et, dès 13:00, ceux du
  lendemain, plus tout jour que Gladys demande (31 jours par requête au plus).
  Un jour n’est gardé qu’entier ; gardés 62 jours dans /data.
- Un 429 (trop de requêtes) ou un 5xx met en pause toutes les requêtes pour
  la durée demandée par l’API, 2 minutes au moins, doublée à chaque fois de
  suite jusqu’à 6 heures ; la pause survit à un redémarrage et le statut
  l’affiche.
- Chaque requête porte le User-Agent propre à l’intégration. Aucun compte,
  aucune clé, aucune donnée personnelle n’est envoyée.
- Le bouton **Tester** affiche, pour 3 contrats au plus, le gestionnaire
  trouvé, la date de lecture de ses tarifs et les parts du prix actuel. Il ne
  fait aucune requête.

Contient des données utilisées selon les « Conditions for use of Danish
public-sector data » du portail Energi Data Service
(www.energidataservice.dk), Energinet. Energinet ne cautionne pas cette
intégration.

## Gestionnaires de réseau

La liste livrée avec cette version (lue le 2026-11-12) : gestionnaires ayant un
tarif résidentiel « Nettarif C » dans DataHub. Un GLN absent de la liste est
accepté avec son code de tarif (DataHub, colonne ChargeTypeCode).

| Gestionnaire                 | GLN           | Codes de tarif résidentiel           |
| ---------------------------- | ------------- | ------------------------------------ |
| Cerius A/S                   | 5790000705184 | 30TR_C_ET, 93TR_C_ET                 |
| Dinel A/S                    | 5790000610099 | TCL<100_02, TCL>100_02               |
| Elektrus A/S                 | 5790000836239 | 6000091                              |
| Elinord A/S                  | 5790001095277 | 43300                                |
| Elnet Midt A/S               | 5790001100520 | 30002, T3001, T3002                  |
| FLOW Elnet A/S               | 5790000392551 | FE1 NT-01, FE2 NT-01                 |
| Forsyning Elnet A/S          | 5790001088309 | STR-NT-03                            |
| Grindsted Elnet A/S          | 5790000681105 | GEV-NT-01                            |
| Hammel Elforsyning Net A/S   | 5790001090166 | C-Tarif                              |
| Ikast El Net A/S             | 5790000682102 | IEV-NT-01, IEV-NT-05                 |
| Konstant Net A/S - 151       | 5790000704842 | 151-NT01T, C_FBTNTR_B                |
| Konstant Net A/S - 245       | 5790000683345 | 245-NT01T, C_FBTNTR_B                |
| L-Net A/S                    | 5790001090111 | 3000, 4010                           |
| Læsø Elnet A/S               | 5790001103460 | 43100                                |
| Midtfyns Elforsyning A.m.b.A | 5790001089023 | NT15000, NT15001, TNT15000, TNT15001 |
| N1 A/S - 016                 | 5790002502699 | C-Tarif, K_21100, K_22100            |
| N1 A/S - 131                 | 5790001089030 | CD                                   |
| N1 A/S - 344                 | 5790000611003 | T-C-F-F-TD, T-C-F-T-TD               |
| Netselskabet Elværk A/S      | 5790000681358 | 5NCFF, 5NCFP                         |
| NOE Net A/S                  | 5790000395620 | 30030, Net C                         |
| Nord Energi Net A/S          | 5790000610877 | TAC                                  |
| Radius Elnet A/S             | 5790000705689 | DT_C_01                              |
| RAH Net A/S                  | 5790000681327 | RAH-C                                |
| Ravdex A/S                   | 5790000836727 | NT-C                                 |
| Sunds Net A.m.b.a            | 5790001095444 | SEF-NT-05                            |
| Tarm Elværk Net A/S          | 5790000706419 | TEV-NT-01, TEV-NT-01T                |
| TREFOR El-net A/S            | 5790000392261 | C                                    |
| TREFOR El-net Øst A/S        | 5790000706686 | 46                                   |
| Veksel A/S                   | 5790001088217 | NT-01, NT-10                         |
| Vores Elnet A/S              | 5790000610976 | TNT1009, TNT1011                     |
| Zeanet A/S                   | 5790001089375 | 43100, 43110                         |
| Aal El-Net A M B A           | 5790001095451 | AAL-NT-05                            |

## Dépannage

- « tariffs of ... not read yet » : attendez quelques minutes (une requête par
  minute).
- « no tariff of ... for <date> » : DataHub n’a pas de tarif de ce code ce
  jour-là ; vérifiez le gestionnaire et le code.
- « has several household tariffs that differ » : remplissez **Code du
  tarif** avec celui de votre facture.
- « Energi Data Service asks to wait » : la limite de l’API est atteinte ;
  rien n’est demandé avant l’heure affichée.
