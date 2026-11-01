/* canvas.js : volet Artifacts (code) et Canvas (Markdown) piloté par l'IA, exposé via window.Canvas */
(function () {
    'use strict';

    // ---------- Constantes ----------

    // Canvas activé par défaut ; choix mémorisé pour toutes les conversations
    const ENABLED_KEY = 'minou-canvas';
    const DEFAULT_ENTRYPOINT = 'index.html';
    // Nom interne d'un texte du Canvas sans titre
    const DEFAULT_DOC_NAME = 'document.md';
    const WIDTH_STORAGE_KEY = 'davidtwentyai-canvas-width';
    const DEFAULT_WIDTH = 640;
    const MIN_WIDTH = 320;
    // Fichiers ajoutés à la main dans une conversation pas encore enregistrée : gardés jusqu'au premier message
    const DRAFT_KEY = 'davidtwentyai-canvas-draft';
    // Sauvegarde des modifications à la main, après une pause de frappe (ms)
    const MANUAL_SAVE_DELAY = 800;

    // Import : tout est gardé sauf dossiers techniques et fichiers système ; tailles en octets
    const IMPORT_MAX_FILE_SIZE = 500 * 1024;
    const IMPORT_CONFIRM_SIZE = 100 * 1024;      // canvas plus gros : confirmation
    const IMPORT_MAX_FILES = 500;
    const IMPORT_IGNORED_DIRS = /^(?:node_modules|\.git|\.svn|\.hg|\.next|\.nuxt|\.cache|\.venv|venv|__pycache__)$/i;
    // Ajoutés par le système (ZIP faits sur Mac…) : écartés sans le signaler
    const IMPORT_SYSTEM_DIRS = /^__MACOSX$/;
    const IMPORT_SYSTEM_FILES = /^(?:\.DS_Store|Thumbs\.db|desktop\.ini|\._.*)$/i;
    const IMPORT_GENERATED_FILES = /(?:\.min\.(?:js|css)|\.map|^package-lock\.json|^yarn\.lock|^pnpm-lock\.yaml|^composer\.lock|^Gemfile\.lock|^poetry\.lock|^Cargo\.lock)$/i;
    const IMPORT_SECRET_FILES = /^\.env(?:\..*)?$/i;
    const IMPORT_BINARY_EXT = /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|heic|psd|ai|sketch|fig|woff2?|ttf|otf|eot|mp3|mp4|m4a|wav|ogg|oga|opus|webm|mov|avi|mkv|flac|aac|pdf|docx?|xlsx?|pptx?|odt|ods|odp|key|pages|numbers|zip|rar|7z|gz|tgz|bz2|xz|tar|jar|exe|msi|dll|so|dylib|bin|dmg|iso|apk|wasm|class|pyc|o|sqlite3?|db)$/i;
    // Noms refusés : ils casseraient les balises <artifact-file name="…"> de l'IA.
    const BAD_NAME_CHARS = /["<>\x00-\x1f\x7f]/;
    // Estimation grossière : un token pour 3,5 caractères (code et français).
    const CHARS_PER_TOKEN = 3.5;

    // Remplace le contenu des balises dans l'historique (l'état réel est dans le prompt) ; ignoré par le parser
    const ARTIFACTS_PLACEHOLDER = '[contenu enregistré dans les Artifacts]';
    const CANVAS_PLACEHOLDER = '[texte enregistré dans le Canvas]';

    // Consignes courtes (petits modèles) ; le rappel du mode va à la fin : ils retiennent surtout la fin

    // Phrases mesurées avec ministral-3-3b (tests/sonde-apercu) : ne pas reformuler sans remesurer
    const PROMPT_NULL = [
        'Deux espaces peuvent s\'ouvrir à côté de la conversation. Par défaut, réponds normalement, sans balise : question, explication, conseil, résumé, traduction ou texte court.',
        '',
        'Artifacts : seulement pour du code à exécuter (page web, application, jeu, outil interactif), pas pour une question sur du code (« comment faire… ? ») : explique-la dans ta réponse. Un fichier par balise ; index.html (avec <!DOCTYPE html>) relié à style.css et script.js ; tout tourne dans le navigateur, sans serveur (ni PHP, ni Python, ni Node) :',
        '<artifact-file name="index.html">',
        'contenu complet du fichier',
        '</artifact-file>',
        '',
        'Canvas : seulement pour rédiger ou retravailler un texte long (lettre, article, rapport, discours, histoire, paroles de chanson, CV…), ou si l\'utilisateur demande le Canvas. Chaque texte en Markdown, dans sa balise ; plusieurs textes demandés : une balise par texte, chacun dans son onglet :',
        '<canvas-doc title="Titre du texte">',
        'texte complet',
        '</canvas-doc>',
        '',
        'Règles : un seul des deux espaces ; ferme toujours la balise ; jamais de bloc ``` autour ; en dehors de la balise, une phrase avant, qui annonce ce que tu vas faire, et une ou deux après, qui expliquent ce que tu as fait.'
    ].join('\n');
    const PROMPT_NULL_REMINDER = 'Rappel : <artifact-file> pour du code à exécuter, <canvas-doc> pour un texte long à rédiger, sinon aucune balise.';
    // Modèles à outils : aucune balise, un modèle qui a des outils et des balises mélange les deux
    const PROMPT_NULL_TOOLS = [
        'Deux espaces peuvent s\'ouvrir à côté de la conversation. Par défaut, réponds normalement, sans outil : question, explication, conseil, résumé, traduction ou texte court.',
        '',
        'Artifacts : seulement pour du code à exécuter (page web, application, jeu, outil interactif), pas pour une question sur du code (« comment faire… ? ») : explique-la dans ta réponse. Crée chaque fichier par un appel de ton outil write_file, avec son contenu complet ; index.html (avec <!DOCTYPE html>) relié à style.css et script.js ; tout tourne dans le navigateur, sans serveur (ni PHP, ni Python, ni Node). N\'écris jamais ce code dans ta réponse.',
        '',
        'Canvas : seulement pour rédiger ou retravailler un texte long (lettre, article, rapport, discours, histoire, paroles de chanson, CV…), ou si l\'utilisateur demande le Canvas. Chaque texte en Markdown, par un appel de ton outil write_document (titre et texte complet) ; plusieurs textes demandés : un appel par texte, tous dans la même réponse, chacun dans son onglet. N\'écris jamais ce texte dans ta réponse.',
        '',
        'Règles : un seul des deux espaces ; avant l\'appel, une phrase qui annonce ce que tu vas faire ; après, une ou deux phrases qui expliquent ce que tu as fait.'
    ].join('\n');
    const PROMPT_NULL_TOOLS_REMINDER = 'Rappel : write_file pour du code à exécuter, write_document pour un texte long à rédiger, sinon aucun outil.';

    // Ce que permet l'aperçu : mesuré avec ministral-3-3b (tests/sonde-apercu.mjs), ne pas reformuler sans remesurer
    const RULE_SITE = '- Site web : le fichier principal est index.html (avec <!DOCTYPE html>), relié à style.css et script.js. La prévisualisation tourne dans le navigateur, sans serveur : ni PHP, ni Python, ni Node. Données à garder : localStorage (SQLite seulement si l\'utilisateur le demande, par sql.js depuis un CDN). fetch() lit les fichiers du projet. Les ressources externes en https:// fonctionnent. Font Awesome : fa-solid pour les icônes, fa-brands pour les logos de marques.';
    const ARTIFACTS_PROMPT = [
        'Tu as accès aux Artifacts : un espace de fichiers affiché à côté de la conversation, pour du code qui s\'exécute (page web, application, jeu, outil interactif). Pour créer ou modifier ses fichiers, écris des balises dans ta réponse. Le reste de ta réponse est affiché normalement à l\'utilisateur.',
        'Ils ne servent qu\'au code : pour une question, une explication ou un texte (poème, lettre, article…), réponds directement dans ta réponse, sans balise et sans toucher aux fichiers.',
        '',
        'Créer un fichier, ou le réécrire en entier :',
        '<artifact-file name="index.html">',
        'contenu complet du fichier',
        '</artifact-file>',
        '',
        'Remplacer un passage précis d\'un fichier existant :',
        '<artifact-edit name="style.css">',
        '<find>texte exact copié du fichier, présent une seule fois</find>',
        '<replace>nouveau texte</replace>',
        '</artifact-edit>',
        '',
        'Supprimer un fichier :',
        '<artifact-delete name="ancien.js" />',
        '',
        '## Règles',
        '- Ferme toujours tes balises.',
        '- Ne mets jamais le code des Artifacts dans un bloc ``` : seul le contenu des balises est enregistré.',
        '- Pour modifier un fichier existant, change seulement ce qui doit changer : tout le reste (règles CSS, sections HTML, fonctions) reste à l\'identique, sauf si l\'utilisateur demande de le supprimer.',
        '- Quelques passages à changer : <artifact-edit>. Si presque tout change, réécris le fichier entier avec <artifact-file>, en recopiant tout ce qui ne change pas, sans raccourci du type « reste du code inchangé ».',
        RULE_SITE,
        '- En dehors des balises : une phrase avant, qui annonce ce que tu vas faire, et une ou deux après, qui expliquent ce que tu as fait.',
        '- Dans tes messages précédents, le contenu des balises a été remplacé par « ' + ARTIFACTS_PLACEHOLDER + ' ». Ne recopie jamais ce texte : les fichiers actuels sont ci-dessous.'
    ].join('\n');
    const ARTIFACTS_PROMPT_OUT = ARTIFACTS_PROMPT.replace('les fichiers actuels sont ci-dessous.', 'les fichiers actuels sont dans la dernière balise <davidtwentyai-state>.');
    const ARTIFACTS_REMINDER = 'Rappel : pour créer ou modifier un fichier des Artifacts, écris <artifact-file name="…">contenu complet</artifact-file> (ou <artifact-edit> avec <find> et <replace>) et ferme la balise. Jamais de bloc ``` pour le code des Artifacts. Ne supprime rien que l\'utilisateur n\'a pas demandé de supprimer.';

    // Modèles à outils : chaque appel est appliqué comme la balise équivalente (parser.toolCall, mêmes contrôles)
    const ARTIFACTS_TOOLS_PROMPT = [
        'Tu as accès aux Artifacts : un espace de fichiers affiché à côté de la conversation, pour du code qui s\'exécute (page web, application, jeu, outil interactif). Pour créer, modifier ou supprimer leurs fichiers, appelle tes outils write_file, edit_file et delete_file. Le texte de ta réponse est affiché normalement à l\'utilisateur.',
        'Ils ne servent qu\'au code : pour une question, une explication ou un texte (poème, lettre, article…), réponds directement, sans outil et sans toucher aux fichiers.',
        '',
        '## Règles',
        '- edit_file pour un changement précis : « find » copié exactement du fichier actuel (espaces et retours à la ligne compris), présent une seule fois. Plusieurs changements : un appel par changement, tous ensemble dans la même réponse (chaque nouvel aller-retour renvoie tout le contexte).',
        '- Pour modifier un fichier existant, change seulement ce qui doit changer : tout le reste (règles CSS, sections HTML, fonctions) reste à l\'identique, sauf si l\'utilisateur demande de le supprimer.',
        '- write_file pour créer un fichier, ou le réécrire en entier si presque tout change : son contenu complet, en recopiant tout ce qui ne change pas, sans raccourci du type « reste du code inchangé ».',
        '- Chaque outil te répond. Si une modification échoue, corrige-la aussitôt (find exact, ou write_file).',
        '- N\'écris jamais le code des Artifacts dans ta réponse, ni dans un bloc ``` : seuls les outils enregistrent les fichiers.',
        RULE_SITE,
        '- Avant d\'appeler tes outils, annonce en une phrase ce que tu vas faire ; une fois les fichiers modifiés, explique en une ou deux phrases ce que tu as fait.'
    ].join('\n');
    const ARTIFACTS_TOOLS_REMINDER = 'Rappel : pour créer ou modifier un fichier des Artifacts, appelle write_file ou edit_file ; jamais de code des Artifacts dans ta réponse. Ne supprime rien que l\'utilisateur n\'a pas demandé de supprimer.';
    // --- Guide de DavidTwentyAI pour l'IA ---
    // Demandé par l'IA (davidtwentyai_guide ou <davidtwentyai-guide />), distinct de la FAQ : à tenir à jour avec l'interface
    const GUIDE_HEAD = 'Guide de DavidTwentyAI, pour toi. Réponds à l\'utilisateur avec ces informations, dans tes mots et seulement ce qui sert sa question, sans recopier ce guide. Les libellés entre « » sont ceux de l\'interface.';
    const GUIDE_COMMON = [
        'Volet du plan de travail',
        '- Il s\'ouvre à droite de la discussion. Tant qu\'il est vide, son en-tête dit « Plan de travail », puis « Artifacts » ou « Canvas ». Le bouton « Plan de travail » de la zone de saisie l\'active ou le désactive pour toutes les conversations.',
        '- Une conversation utilise un seul des deux espaces : Artifacts (code qui s\'exécute) ou Canvas (texte rédigé à deux). Pour passer à l\'autre : nouvelle conversation, ou vider le volet (corbeille de l\'en-tête).',
        '- En-tête du volet : « Plein écran » (Échap pour revenir), « Historique des versions », « Télécharger », corbeille, « Fermer ».',
        '- « Historique des versions » : une version par réponse de l\'IA qui a modifié les fichiers ou le texte, plus l\'état de départ. « Annuler » et « Remettre » parcourent les versions, « Appliquer » garde celle affichée. L\'historique est gardé avec la conversation.',
        '- « Afficher les modifications » (pied du volet) surligne ce que la dernière réponse de l\'IA a changé.',
        '- Régénérer une réponse de l\'IA annule ce qu\'elle avait modifié, après confirmation.',
        '- Dans la saisie, « @ » cite un fichier ou un document : il t\'est envoyé en entier (le début seulement d\'un très gros fichier des Artifacts).'
    ].join('\n');
    const GUIDE_ARTIFACTS = [
        'Artifacts',
        '- Onglets « Code » (liste des fichiers, modifiables à la main) et « Prévisualiser » (la page tourne).',
        '- Sous la liste des fichiers : « Nouveau » et « Importer » (fichiers, dossier ou ZIP). On peut aussi glisser des fichiers, un dossier ou un ZIP sur le volet (50 Mo au plus). Au survol d\'un fichier : renommer, supprimer, et le cadenas, qui t\'interdit de le modifier.',
        '- Fichiers grisés (images, polices, fichiers minifiés ou générés, .env, textes de plus de 1 Mo) : tu ne peux ni les lire ni les modifier, mais ils servent à l\'aperçu et au ZIP.',
        '- Télécharger : « Télécharger en ZIP » (en-tête) donne tout le projet. Un fichier seul : bouton « Télécharger ce fichier », au survol de son nom dans la liste des fichiers.',
        '- Ouvrir hors de DavidTwentyAI : décompresser le ZIP, puis ouvrir index.html dans un navigateur. Ouverte ainsi depuis le disque (adresse file://), la page ne peut ni charger un script en module qui est un fichier du projet (<script type="module" src="script.js">, ou import de ./autre.js ; courant avec three.js), ni lire les fichiers du projet avec fetch() : elle reste vide ou incomplète. Il faut alors lancer un petit serveur dans le dossier (par exemple python3 -m http.server, puis http://localhost:8000) ou l\'extension Live Server de VS Code. Seulement si l\'utilisateur demande que la page s\'ouvre par un double-clic : écrire ce module dans index.html (<script type="module">…</script>), ses import venant d\'un CDN en https. Pour mettre le site en ligne : un hébergeur de sites statiques (GitHub Pages, Netlify…).',
        '- « Actualiser la prévisualisation » recharge l\'aperçu. « Sélectionner un élément de la page » : un clic sur un élément de l\'aperçu propose « Demander à l\'IA » (la demande t\'arrive avec cet élément) ou « Modifier le texte » sur place.',
        '- « Console » (pied du volet) : messages et erreurs de la page ; « Envoyer à l\'IA » te les transmet pour que tu corriges.',
        '',
        'Ce que l\'aperçu permet (pour écrire du code qui y marche)',
        '- Il tourne dans le navigateur, dans un cadre isolé, sans serveur : ni PHP, ni Python, ni Node, ni base de données sur serveur.',
        '- fetch(\'chemin\') en GET lit les fichiers du projet (pas XMLHttpRequest). Bibliothèques, polices et images en ligne (https) se chargent.',
        '- localStorage et sessionStorage marchent, mais en mémoire : vidés à chaque rechargement de l\'aperçu (après une modification des fichiers, ou « Actualiser »). Hors de DavidTwentyAI, ils sont gardés. IndexedDB et les cookies ne marchent pas dans l\'aperçu.',
        '- alert(), confirm(), prompt() et les formulaires marchent. Un lien vers une autre page du projet s\'ouvre dans l\'aperçu, un lien vers un autre site dans un nouvel onglet.',
        '- Pas de caméra, de micro ni de géolocalisation dans l\'aperçu, ni de lecture du presse-papiers. Copier dans le presse-papiers, télécharger un fichier créé par la page, capturer la souris (jeux) et le plein écran marchent.',
        '- Gros projet (au-delà d\'environ 85 ko de fichiers) : tu reçois la liste des fichiers avec leur plan, et tu lis ceux qu\'il te faut.'
    ].join('\n');
    const GUIDE_CANVAS = [
        'Canvas',
        '- Le texte se modifie directement. Sélectionner un passage affiche une barre : style (titre, citation, liste), gras, italique, barré, code, lien, et « Demander à l\'IA » (tu ne modifies alors que ce passage).',
        '- Plusieurs documents : un onglet chacun, en haut du texte. Double-clic pour renommer, croix pour supprimer, glisser pour changer l\'ordre ; « + » propose « Nouvel onglet » ou « Importer ».',
        '- Importer : Word (.docx), PDF (texte seulement, sans les images), Markdown, texte, page web ; ou glisser le fichier sur le volet.',
        '- « Télécharger le texte » (en-tête) : Markdown (.md), page HTML (.html) ou texte (.txt), et « Tous les documents » en ZIP s\'il y en a plusieurs. Pas d\'export Word ni PDF : « Copier le texte » (en haut à droite du document), puis coller dans Word ou Google Docs, mise en forme comprise ; pour un PDF, ouvrir la page HTML téléchargée dans le navigateur et l\'imprimer en PDF.'
    ].join('\n');
    function davidtwentyaiGuide(mode) {
        const parts = mode === 'artifacts' ? [GUIDE_COMMON, GUIDE_ARTIFACTS] : mode === 'canvas' ? [GUIDE_COMMON, GUIDE_CANVAS] : [GUIDE_COMMON, GUIDE_ARTIFACTS, GUIDE_CANVAS];
        return [GUIDE_HEAD, ...parts].join('\n\n');
    }
    // Modèles sans outils : la balise, au même endroit dans toutes les consignes
    const GUIDE_TAG_NOTE = 'Question sur DavidTwentyAI lui-même (télécharger, importer, ouvrir le projet hors de DavidTwentyAI, versions, aperçu) : écris <davidtwentyai-guide /> ; DavidTwentyAI te donnera son guide et tu continueras ta réponse.';
    const TOOL_NAME_PROP = { type: 'string', description: 'Chemin du fichier dans les Artifacts, par exemple index.html ou css/style.css' };

    // La même avec ou sans passage choisi : les outils ne changent pas (cache)
    const FIND_DOC_DESCRIPTION = 'Passage exact à remplacer, présent une seule fois. Vide pour remplacer le passage choisi par l\'utilisateur (« Passage choisi dans le texte du Canvas »).';
    const FILE_TOOLS = {
        write_file: { name: 'write_file', description: 'Crée un fichier des Artifacts, ou le remplace entièrement. Donne son contenu complet, sans raccourci.',
            parameters: { type: 'object', properties: { name: TOOL_NAME_PROP, content: { type: 'string', description: 'Contenu complet du fichier' } }, required: ['name', 'content'] } },
        edit_file: { name: 'edit_file', description: 'Remplace un passage d\'un fichier existant des Artifacts. « find » doit être copié exactement du fichier actuel et n\'y apparaître qu\'une fois.',
            parameters: { type: 'object', properties: { name: TOOL_NAME_PROP, find: { type: 'string', description: 'Texte exact à remplacer, présent une seule fois dans le fichier' }, replace: { type: 'string', description: 'Nouveau texte' } }, required: ['name', 'find', 'replace'] } },
        delete_file: { name: 'delete_file', description: 'Supprime un fichier des Artifacts.',
            parameters: { type: 'object', properties: { name: TOOL_NAME_PROP }, required: ['name'] } },
        read_file: { name: 'read_file', description: 'Lit un fichier des Artifacts dont tu n\'as que le plan : en entier, ou les lignes from à to.',
            parameters: { type: 'object', properties: { name: TOOL_NAME_PROP, from: { type: 'integer', description: 'Première ligne à lire (facultatif)' }, to: { type: 'integer', description: 'Dernière ligne à lire (facultatif)' } }, required: ['name'] } },
        write_document: { name: 'write_document', description: 'Écrit le texte du Canvas, en Markdown, ou le remplace entièrement. Donne le texte complet, sans rien omettre.',
            parameters: { type: 'object', properties: { title: { type: 'string', description: 'Titre du texte' }, content: { type: 'string', description: 'Texte complet, en Markdown' } }, required: ['title', 'content'] } },
        edit_document: { name: 'edit_document', description: 'Remplace un passage du texte du Canvas. « find » doit être copié exactement du texte actuel et n\'y apparaître qu\'une fois.',
            parameters: { type: 'object', properties: { find: { type: 'string', description: FIND_DOC_DESCRIPTION }, replace: { type: 'string', description: 'Nouveau passage' } }, required: ['find', 'replace'] } },
        create_document: { name: 'create_document', description: 'Crée un nouveau document dans le Canvas, à côté des autres, seulement si l\'utilisateur demande un autre texte. Jamais pour réécrire un document existant (write_document).',
            parameters: { type: 'object', properties: { title: { type: 'string', description: 'Titre du nouveau document' }, content: { type: 'string', description: 'Texte complet, en Markdown' } }, required: ['title', 'content'] } },
        rename_document: { name: 'rename_document', description: 'Change seulement le titre du document du Canvas ; son texte reste tel quel.',
            parameters: { type: 'object', properties: { title: { type: 'string', description: 'Nouveau titre' } }, required: ['title'] } },
        read_document: { name: 'read_document', description: 'Lit en entier un document du Canvas dont tu n\'as que le plan.',
            parameters: { type: 'object', properties: { document: { type: 'string', description: 'Titre du document' } }, required: ['document'] } },
        read_console: { name: 'read_console', description: 'Lit la console de la page affichée dans l\'aperçu : erreurs JavaScript et avertissements, répétitions regroupées. Pour trouver la cause d\'un bug.',
            parameters: { type: 'object', properties: { all: { type: 'boolean', description: 'Aussi les messages ordinaires (facultatif)' } } } },
        // Paramètre facultatif : Gemini refuse un objet sans propriété
        davidtwentyai_guide: { name: 'davidtwentyai_guide', description: 'Guide de l\'interface de DavidTwentyAI (Artifacts et Canvas) : comment l\'utilisateur télécharge, importe, retrouve une version ou ouvre le projet hors de DavidTwentyAI, et ce que l\'aperçu permet (pas de serveur, stockage…). Appelle-le avant de répondre à une question sur DavidTwentyAI lui-même, au lieu de deviner.',
            parameters: { type: 'object', properties: { question: { type: 'string', description: 'Ce que l\'utilisateur veut savoir (facultatif)' } } } }
    };
    // Plusieurs documents : write_document et edit_document visent un document par son titre
    const DOC_TARGET_PROP = { type: 'string', description: 'Titre du document visé (facultatif : par défaut, le document affiché)' };
    const MULTI_DOC_TOOLS = {
        write_document: { ...FILE_TOOLS.write_document, description: 'Réécrit entièrement un document du Canvas, en Markdown. Donne le texte complet, sans rien omettre.',
            parameters: { type: 'object', properties: { document: DOC_TARGET_PROP, title: { type: 'string', description: 'Titre du document' }, content: { type: 'string', description: 'Texte complet, en Markdown' } }, required: ['title', 'content'] } },
        edit_document: { ...FILE_TOOLS.edit_document, description: 'Remplace un passage d\'un document du Canvas. « find » doit être copié exactement du document et n\'y apparaître qu\'une fois.',
            parameters: { type: 'object', properties: { document: DOC_TARGET_PROP, find: { type: 'string', description: FIND_DOC_DESCRIPTION }, replace: { type: 'string', description: 'Nouveau passage' } }, required: ['find', 'replace'] } },
        rename_document: { ...FILE_TOOLS.rename_document, description: 'Change seulement le titre d\'un document du Canvas ; son texte reste tel quel.',
            parameters: { type: 'object', properties: { document: DOC_TARGET_PROP, title: { type: 'string', description: 'Nouveau titre' } }, required: ['title'] } }
    };


    /* Format neutre (api.js le traduit par fournisseur) ; read_file seulement pour un gros projet */
    function artifactToolSpecs() {
        return [...spaceToolSpecs(), FILE_TOOLS.davidtwentyai_guide];
    }
    function spaceToolSpecs() {
        const T = FILE_TOOLS;
        const mode = currentMode();
        if (!mode) return [T.write_file, T.write_document];
        if (mode === 'canvas') {
            const docs = docNamesOf(state.files);
            if (docs.length > 1) {
                const tools = [MULTI_DOC_TOOLS.edit_document, MULTI_DOC_TOOLS.write_document, T.create_document, MULTI_DOC_TOOLS.rename_document];
                return canvasDocsLayout().summarized.length ? [...tools, T.read_document] : tools;
            }
            const doc = activeDoc();
            return doc && String(state.files[doc]).trim() ? [T.edit_document, T.write_document, T.create_document, T.rename_document] : [T.write_document];
        }
        return isIndexMode() ? [T.write_file, T.edit_file, T.delete_file, T.read_file, T.read_console] : [T.write_file, T.edit_file, T.delete_file, T.read_console];
    }

    // Canvas : consignes construites par canvasDocPrompt, par balises ou par outils
    const CANVAS_RULE_KEEP = '- Change seulement ce qui doit changer : tout le reste du texte reste à l\'identique, sauf si l\'utilisateur demande de le supprimer.';
    const CANVAS_RULES = [
        '- Garde la langue et le style du texte. N\'invente pas de faits (noms, dates, chiffres) : écris [à compléter].',
        '- Markdown simple (titres #, **gras**, *italique*, listes, citations, tableaux) ; ni HTML ni code.'
    ];
    const CANVAS_RULE_PLACEHOLDER = '- Dans tes messages précédents, le texte a été remplacé par « ' + CANVAS_PLACEHOLDER + ' » : ne recopie jamais cela, le texte actuel est ci-dessous.';
    const CANVAS_RULE_PLACEHOLDER_OUT = CANVAS_RULE_PLACEHOLDER.replace('le texte actuel est ci-dessous.', 'le texte actuel est dans la dernière balise <davidtwentyai-state>.');
    const CANVAS_REMINDER = 'Rappel : pour changer le texte du Canvas, écris <canvas-doc-edit><find>passage exact</find><replace>nouveau passage</replace></canvas-doc-edit>, ou réécris tout le texte dans <canvas-doc>…</canvas-doc>, et ferme la balise. Ne supprime rien que l\'utilisateur n\'a pas demandé de supprimer.';
    const CANVAS_MULTI_REMINDER = 'Rappel : pour changer un document, écris <canvas-doc-edit title="titre du document"><find>passage exact</find><replace>nouveau passage</replace></canvas-doc-edit>, ou réécris tout le document dans <canvas-doc title="titre du document">…</canvas-doc>, et ferme la balise. Ne supprime rien que l\'utilisateur n\'a pas demandé de supprimer.';
    const CANVAS_TOOLS_REMINDER = 'Rappel : pour changer le texte du Canvas, appelle edit_document (ou write_document si presque tout change) ; jamais le texte du Canvas dans ta réponse. Ne supprime rien que l\'utilisateur n\'a pas demandé de supprimer.';
    // Modèles du cloud à outils : l'état part dans <davidtwentyai-state> d'un message, le prompt système reste stable (cache)
    const STATE_NOTES = {
        files: 'Les fichiers actuels des Artifacts te sont donnés par DavidTwentyAI dans la dernière balise <davidtwentyai-state> de la conversation, au début d\'un message de l\'utilisateur (il ne l\'a pas écrite) : c\'est leur état à jour.',
        text: 'Le texte actuel du Canvas t\'est donné par DavidTwentyAI dans la dernière balise <davidtwentyai-state> de la conversation, au début d\'un message de l\'utilisateur (il ne l\'a pas écrite) : c\'est son état à jour.',
        docs: 'Les documents actuels du Canvas te sont donnés par DavidTwentyAI dans la dernière balise <davidtwentyai-state> de la conversation, au début d\'un message de l\'utilisateur (il ne l\'a pas écrite) : c\'est leur état à jour.'
    };

    // ---------- État ----------

    const state = {
        active: false,
        files: Object.create(null),   // { 'index.html': 'content', ... }
        entrypoint: DEFAULT_ENTRYPOINT,
        // null, 'artifacts' ou 'canvas' : fixé au premier fichier, remis à null si l'utilisateur vide tout
        mode: null,
        // Titre de chaque texte du Canvas { nom: titre } ; le texte affiché est state.selectedFile
        docTitles: Object.create(null),
        // Une version par réponse de l'IA qui a modifié les fichiers, plus l'état de départ (app.js, setVersions)
        versions: [],                 // [{ files, mode, docTitles, label }]
        _timeline: null,              // frise calculée (versionTimeline), en cache
        historyNav: null,             // barre d'historique ouverte : { list, index, snap }
        selectedFile: null,
        lastError: null,
        activeTab: 'code',            // 'code' | 'preview'
        previewDirty: true,
        showDiff: false,              // afficher la diff (vert/rouge) vs baseline
        baseline: Object.create(null),// snapshot { filename: content } pris en début de tour IA
        // Fichiers verrouillés : l'IA les lit mais ne peut ni les modifier ni les supprimer
        lockedFiles: new Set(),
        previewCurrentFile: null,     // fichier HTML actuellement affiché en preview (null = entrypoint)
        // Fichier en cours d'écriture par l'IA, affiché en direct : { kind: 'file'|'edit', name, partial }
        streamingFile: null,
        // Conversation du canvas chargé (null : pas encore enregistrée), pour savoir si un tour d'IA le concerne
        convId: null,
        // Échecs d'application à signaler à l'IA au tour suivant, pour qu'elle se corrige
        opErrors: [],
        // Tours d'IA en échec : d'affilée et au total, pour le modèle courant.
        failStreak: 0,
        failTotal: 0,
        failModel: null,
        // Lecture seule pendant une réponse : la copie de travail de l'IA ne verrait pas les modifications à la main
        busy: false,
        // Fichier que l'IA modifie pendant qu'on regarde l'aperçu (pied du volet), null sinon
        aiWriting: null,
        // Aperçu depuis Configuration > Stockage : rien n'y est modifiable (app.js, setLocked)
        locked: false,
        // Fichiers tels que l'IA les connaît : l'écart avec files (modifs à la main) lui est signalé au message suivant
        aiFiles: Object.create(null),
        // Gros projet : fichiers vus par l'IA (récents d'abord), lus ce tour, envoyés en entier (null : tous)
        workingSet: [],
        turnReads: new Set(),
        promptFull: null,
        // Fichiers que l'IA ne lit pas : nom → { hash, type, size, why }
        assets: Object.create(null),
        // Modification à la main : une seule version d'historique par séance (jusqu'à la sortie de l'éditeur)
        editSession: null,
        // Saisie d'un nom dans la liste : { mode: 'new' } ou { mode: 'rename', name }
        naming: null,
        _editor: null,                // vue Code du fichier affiché (lignes + zone de saisie)
        _saveTimer: null,
        _statusFlash: null,           // message temporaire du pied de page { text, title, error, until }
        _loadSeq: 0,                  // change à chaque conversation chargée (imports asynchrones)
        _dom: null,
        _previewMsgListener: null,    // listener postMessage pour navigation intra-preview
        previewHash: '',              // ancre à atteindre dans la page chargée (lien « page.html#section »)
        // Page atteinte par un lien de l'aperçu : { from, page } ; oubliée dès qu'on choisit un autre fichier
        previewNav: null,
        _loadingTimer: 0,
        // Console de l'aperçu : { level, text, where }, vidée à chaque page chargée
        consoleEntries: [],
        consolePage: '',
        consoleOpen: false,
        _consoleFrame: 0,
    };

    // ---------- Utilitaires ----------

    function enabledByDefault() {
        try { return localStorage.getItem(ENABLED_KEY) !== '0'; } catch (e) { return true; }
    }

    function cloneFiles(files) {
        const copy = Object.create(null);
        for (const k in files) copy[k] = files[k];
        return copy;
    }

    function snapshotState() {
        return { files: cloneFiles(state.files), assets: cloneAssets(state.assets), entrypoint: state.entrypoint, mode: state.mode, docTitles: cloneTitles(state.docTitles), selectedFile: state.selectedFile };
    }

    // ---------- Mode de la conversation (Artifacts ou Canvas) ----------

    /* Pas de .txt : ce n'est pas du Markdown, il reste dans les Artifacts */
    const DOC_FILE_RE = /\.(?:md|markdown)$/i;
    /* Ancien format : un fichier texte d'une balise désigne le Canvas, sauf dans une conversation Artifacts */
    const TEXT_FILE_RE = /\.(?:md|markdown|txt)$/i;

    /* Conversations anciennes sans mode : un seul Markdown → Canvas, sinon Artifacts */
    function inferMode(files) {
        const names = Object.keys(files || {});
        if (!names.length) return null;
        return names.length === 1 && DOC_FILE_RE.test(names[0]) ? 'canvas' : 'artifacts';
    }

    function normalizeMode(mode, files, fallback) {
        if (!Object.keys(files || {}).length) return null;
        if (mode === 'artifacts' || mode === 'canvas') return mode;
        if (fallback === 'artifacts' || fallback === 'canvas') return fallback;
        return inferMode(files);
    }

    /** Fichier qui porte le texte du Canvas (le seul, ou le premier Markdown). */
    function docFileOf(files) {
        const names = Object.keys(files || {});
        if (names.length <= 1) return names[0] || null;
        return names.find(n => DOC_FILE_RE.test(n)) || names.sort()[0];
    }

    /* Ordre des onglets = ordre des clés de files (création, ou reorderDocs) */
    function docNamesOf(files) {
        return Object.keys(files || {});
    }

    function activeDocOf(files, selected) {
        if (selected && files && Object.prototype.hasOwnProperty.call(files, selected)) return selected;
        return docFileOf(files);
    }

    function activeDoc() {
        return state.mode === 'canvas' ? activeDocOf(state.files, state.selectedFile) : null;
    }

    function cloneTitles(titles) {
        return Object.assign(Object.create(null), titles || {});
    }

    /* Accepte aussi l'ancien docTitle (un seul texte), rattaché au texte affiché */
    function titlesFrom(src, files, selected) {
        const out = Object.create(null);
        if (src && src.docTitles && typeof src.docTitles === 'object') {
            for (const k in src.docTitles) if (typeof src.docTitles[k] === 'string' && files && k in files) out[k] = src.docTitles[k];
        } else if (src && typeof src.docTitle === 'string' && src.docTitle) {
            const doc = activeDocOf(files, selected);
            if (doc) out[doc] = src.docTitle;
        }
        return out;
    }

    function titlesToSave(titles, files, mode) {
        if (mode !== 'canvas') return undefined;
        const out = {};
        let n = 0;
        for (const k in titles || {}) if (files && k in files && titles[k]) { out[k] = titles[k]; n++; }
        return n ? out : undefined;
    }

    /** Titre affiché d'un texte : le sien, sinon son premier titre « # ». */
    function docTitleIn(files, titles, name) {
        return name && files && name in files ? resolveDocTitle((titles && titles[name]) || '', files[name], '') : '';
    }

    function docByTitle(files, titles, title) {
        const t = String(title || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!t || !files) return null;
        for (const n of docNamesOf(files)) if (docTitleIn(files, titles, n).toLowerCase() === t) return n;
        const slug = docNameFromTitle(title);
        return slug in files ? slug : (t in files ? t : null);
    }

    /* Le titre le plus long l'emporte (« @Lettre au maire » ne cite pas « Lettre ») ; casse et espaces ignorées */
    function docMentionRanges(text, files, titles) {
        const s = String(text || '');
        if (s.indexOf('@') < 0 || !files) return [];
        const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const cands = [];
        for (const n of docNamesOf(files)) {
            for (const f of new Set([docTitleIn(files, titles, n), n])) {
                const form = String(f || '').replace(/\s+/g, ' ').trim();
                if (form) cands.push({ n, form });
            }
        }
        cands.sort((a, b) => b.form.length - a.form.length);
        const out = [];
        for (const { n, form } of cands) {
            const re = new RegExp('(^|[\\s(«"\'\\[{])@' + esc(form).replace(/ /g, '\\s+') + '(?![\\p{L}\\p{N}_])', 'giu');
            for (const m of s.matchAll(re)) {
                const start = m.index + m[1].length, end = m.index + m[0].length;
                if (!out.some(r => start < r.end && end > r.start)) out.push({ start, end, name: n });
            }
        }
        return out.sort((a, b) => a.start - b.start);
    }

    function atMentionedDocs(text, files, titles) {
        const cited = new Set(docMentionRanges(text, files, titles).map(r => r.name));
        return docNamesOf(files).filter(n => cited.has(n));
    }

    function lastUserText(history) {
        const m = Array.isArray(history) ? history.slice().reverse().find(x => x && x.role === 'user') : null;
        if (!m) return '';
        if (typeof m.content === 'string') return m.content;
        return Array.isArray(m.content) ? m.content.map(p => (p && typeof p.text === 'string' ? p.text : '')).join('\n') : '';
    }

    function freeDocName(files, title) {
        const base = docNameFromTitle(title || 'document').replace(/\.md$/, '');
        let name = base + '.md';
        for (let i = 2; files && name in files; i++) name = `${base}-${i}.md`;
        return name;
    }

    function docNameFromTitle(title) {
        const slug = String(title || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
        return slug ? slug + '.md' : 'document.md';
    }

    // Titre recopié de l'exemple des consignes, ou vide : ignoré.
    const TITLE_PLACEHOLDER_RE = /^(?:[.…\s]*|titre|titre du texte|titre du document|title|\{titre\}|sans titre)$/i;

    function resolveDocTitle(tagTitle, text, current) {
        const t = String(tagTitle || '').replace(/\s+/g, ' ').trim();
        if (t && !TITLE_PLACEHOLDER_RE.test(t)) return t.slice(0, 200);
        const h = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(String(text || ''));
        if (h && h[1].trim()) return h[1].replace(/[*_`]+/g, '').trim().slice(0, 200);
        return current || '';
    }

    /* Sans fichier, plus de mode ; un premier fichier fixe le mode (preferred, sinon déduit) */
    function settleUserMode(preferred) {
        if (!Object.keys(state.files).length && !hasAssets()) {
            state.mode = null;
            state.docTitles = Object.create(null);
        } else if (!state.mode) {
            state.mode = preferred || inferMode(state.files) || 'artifacts';
        }
    }

    /* Une version par réponse (vides, autre espace et doublons écartés), puis l'état actuel s'il n'en est aucune ; list.current : son rang */
    function versionTimeline() {
        if (state._timeline) return state._timeline;
        const mode = state.mode;
        const cur = snapshotState();
        const out = [];
        // Canvas : un titre changé fait une version (réponse qui n'a fait que renommer), si la version a gardé ses titres
        const sameTitles = (files, a, b) => mode !== 'canvas' || Object.keys(files).every(k => docTitleIn(files, a, k) === docTitleIn(files, b, k));
        if (mode) {
            for (const v of state.versions) {
                const files = v.files || {};
                if (!Object.keys(files).length || (normalizeMode(v.mode, files, mode) || 'artifacts') !== mode) continue;
                const last = out[out.length - 1];
                const titles = titlesFrom(v, files, v.selectedFile);
                const explicitTitles = !!(v.docTitles && typeof v.docTitles === 'object');
                if (last && filesEqual(last.files, files) && (!explicitTitles || !last.explicitTitles || sameTitles(files, last.docTitles, titles))) { out[out.length - 1] = { ...last, label: v.label || last.label }; continue; }
                out.push({ files, assets: v.assets && typeof v.assets === 'object' ? v.assets : undefined, entrypoint: state.entrypoint, mode,
                    docTitles: titles, explicitTitles, selectedFile: typeof v.selectedFile === 'string' ? v.selectedFile : undefined, label: v.label || '' });
            }
        }
        // État actuel déjà dans la liste (version plus ancienne remise) : c'est elle, l'« actuelle », sans doublon
        let at = -1;
        for (let i = out.length - 1; i >= 0 && at < 0; i--) if (filesEqual(out[i].files, cur.files) && (!out[i].explicitTitles || sameTitles(cur.files, out[i].docTitles, cur.docTitles))) at = i;
        if (at >= 0) out[at] = { ...cur, label: out[at].label };
        else { out.push({ ...cur, label: '' }); at = out.length - 1; }
        out.current = at;
        state._timeline = out;
        return out;
    }

    function setVersions(list) {
        state.versions = Array.isArray(list) ? list.filter(v => v && v.files && typeof v.files === 'object') : [];
        state._timeline = null;
        if (!state.historyNav) renderHistoryUi(dom());
    }

    /* Pas de version par modification : il y en a une par réponse de l'IA (setVersions) */
    function pushHistory() {
        if (state.historyNav) closeHistoryNav(true);
        state._timeline = null;
        state.previewDirty = true;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function fileExtension(name) {
        const i = name.lastIndexOf('.');
        return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
    }

    // Traits de 14 px, comme les icônes « Nouveau » et « Importer »
    const FILE_ICON_PATHS = {
        page: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
        style: '<path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z"/><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/>',
        code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
        data: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
        text: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
        image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
        table: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 9v12"/><path d="M15 9v12"/>',
        file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'
    };
    const FILE_ICON_TYPES = {
        html: 'page', htm: 'page',
        css: 'style', scss: 'style', sass: 'style', less: 'style',
        js: 'code', mjs: 'code', cjs: 'code', ts: 'code', jsx: 'code', tsx: 'code', vue: 'code', svelte: 'code',
        py: 'code', php: 'code', rb: 'code', java: 'code', c: 'code', h: 'code', cpp: 'code', cs: 'code',
        go: 'code', rs: 'code', swift: 'code', kt: 'code', sh: 'code', sql: 'code', xml: 'code',
        json: 'data', yml: 'data', yaml: 'data', toml: 'data', ini: 'data',
        md: 'text', markdown: 'text', txt: 'text',
        svg: 'image', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', ico: 'image',
        csv: 'table', tsv: 'table'
    };

    function iconForFile(name) {
        const type = FILE_ICON_TYPES[fileExtension(name)] || 'file';
        return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            FILE_ICON_PATHS[type] + '</svg>';
    }

    function byteSize(str) {
        try { return new Blob([str]).size; } catch { return str.length; }
    }

    function formatSize(b) {
        if (b < 1024) return b + ' o';
        if (b < 1024 * 1024) return (b / 1024).toFixed(1).replace('.', ',') + ' ko';
        return (b / 1024 / 1024).toFixed(2).replace('.', ',') + ' Mo';
    }

    function plural(n, one, many) {
        return n + ' ' + (n > 1 ? many : one);
    }

    /* Compte rendu d'outil : un modèle à outils ne doit pas être poussé vers les balises */
    function toolWords(msg) {
        return String(msg)
            .replace(/<canvas-doc-rename> sans nouveau titre \(to="…"\)/g, 'rename_document sans nouveau titre (« title »)')
            .replace(/<canvas-doc-rename>/g, 'rename_document')
            .replace(/(?:Balise |balise )?<canvas-doc-edit>/g, 'edit_document')
            .replace(/(?:Balise |balise )?<canvas-doc>/g, 'write_document')
            .replace(/(?:Balise |balise )?<artifact-edit>/g, 'edit_file')
            .replace(/(?:Balise |balise )?<artifact-file>/g, 'write_file')
            .replace(/(?:Texte )?<find>/g, '« find »')
            .replace(/<replace>/g, '« replace »');
    }

    /* « /x », « ./x » et « .. » ramenés au projet ; caractères interdits (BAD_NAME_CHARS) remplacés */
    function aiFileName(name) {
        return normalizePath(String(name || '').trim()).replace(/["<>\x00-\x1f\x7f]/g, '_');
    }

    /* « .. » remonte d'un dossier (ignoré à la racine) */
    function normalizePath(p) {
        const out = [];
        for (const seg of String(p).replace(/\\/g, '/').split('/')) {
            if (!seg || seg === '.') continue;
            if (seg === '..') out.pop();
            else out.push(seg);
        }
        return out.join('/');
    }

    /* Retourne { name } ou { error } ; current : nom actuel, qui peut changer de casse */
    function checkFileName(raw, current) {
        const name = normalizePath(String(raw || '').trim());
        if (!name) return { error: 'Nom vide' };
        if (BAD_NAME_CHARS.test(name)) return { error: 'Caractères interdits\u00a0: " < >' };
        if (name.length > 200) return { error: 'Nom trop long' };
        const lower = name.toLowerCase();
        if (allFileNames().some(n => n !== current && n.toLowerCase() === lower)) {
            return { error: 'Un fichier porte déjà ce nom' };
        }
        return { name };
    }

    function canvasTokens() {
        return Math.round(systemPromptSuffixText(null).length / CHARS_PER_TOKEN);
    }

    function roundTokens(n) {
        const step = n < 1000 ? 10 : n < 10000 ? 100 : 1000;
        return (Math.round(n / step) * step).toLocaleString('fr-FR');
    }

    // ---------- Modifications à la main ----------

    function describeManualChanges() {
        const a = state.aiFiles;
        const f = state.files;
        const removed = Object.keys(a).filter(n => !(n in f)).sort();
        const renamedFrom = new Set();
        const out = [];
        for (const n of Object.keys(f).sort()) {
            if (n in a) {
                if (a[n] !== f[n]) out.push(n + ' (modifié)');
                continue;
            }
            const from = removed.find(r => !renamedFrom.has(r) && a[r] === f[n]);
            if (from) {
                renamedFrom.add(from);
                out.push(`${n} (renommé, ancien nom : ${from})`);
            } else {
                out.push(n + ' (ajouté)');
            }
        }
        for (const r of removed) if (!renamedFrom.has(r)) out.push(r + ' (supprimé)');
        return out;
    }

    function readDraft() {
        try {
            const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
            return d && ((d.files && typeof d.files === 'object') || (d.assets && typeof d.assets === 'object')) ? { ...d, files: d.files && typeof d.files === 'object' ? d.files : {} } : null;
        } catch (e) { return null; }
    }

    function writeDraft() {
        if (state.convId != null) return;
        const shown = state.historyNav ? state.historyNav.snap : state;
        const assets = shown.assets || state.assets;
        try {
            if (!Object.keys(shown.files).length && !Object.keys(assets).length) localStorage.removeItem(DRAFT_KEY);
            else localStorage.setItem(DRAFT_KEY, JSON.stringify({ files: shown.files, assets: Object.keys(assets).length ? assets : undefined,
                lockedFiles: lockedList(shown.files), selectedFile: state.selectedFile, mode: shown.mode || null, docTitles: titlesToSave(shown.docTitles, shown.files, shown.mode) }));
        } catch (e) { /* stockage plein ou indisponible */ }
    }

    function clearDraft() {
        try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* stockage indisponible */ }
    }

    function persistNow() {
        clearTimeout(state._saveTimer);
        state._saveTimer = null;
        if (state.convId == null) writeDraft();
        if (typeof window.saveConversation === 'function') window.saveConversation();
    }

    function schedulePersist() {
        clearTimeout(state._saveTimer);
        state._saveTimer = setTimeout(persistNow, MANUAL_SAVE_DELAY);
    }

    function flushPersist() {
        if (state._saveTimer) persistNow();
    }

    function endEditSession() {
        if (!state.editSession) return;
        state.editSession = null;
        flushPersist();
    }

    function canManageFiles() {
        return !state.busy && !state.historyNav && !state.locked;
    }

    function manageBlockedReason() {
        if (state.locked) return 'Aperçu\u00a0: lecture seule';
        if (state.busy) return 'Disponible quand l\'IA aura fini de répondre';
        if (state.historyNav) return 'Fermez d\'abord l\'historique des versions';
        return '';
    }

    function readOnlyReason(name) {
        if (!name || !(name in state.files)) return 'busy';
        if (state.streamingFile && state.streamingFile.name === name) return 'busy';
        if (state.busy) return 'busy';
        if (state.locked) return 'locked';
        if (state.historyNav) return 'history';
        if (state.showDiff) return 'diff';
        return null;
    }

    // ---------- Mutations ----------
    // computeBlock est pur : il sert aussi à la copie de travail d'un tour d'IA en arrière-plan

    function escapeRegExp(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /* Identique, puis espaces de bord de ligne, typographie (prose), sans guillemets, autre casse initiale */
    function locateFind(src, find, prose) {
        if (!find) return { error: 'empty' };
        const idx = src.indexOf(find);
        if (idx >= 0) {
            if (src.indexOf(find, idx + 1) >= 0) return { error: 'ambiguous' };
            return { start: idx, end: idx + find.length };
        }
        const lines = find.split('\n').map(l => l.trim());
        while (lines.length && !lines[0]) lines.shift();
        while (lines.length && !lines[lines.length - 1]) lines.pop();
        if (lines.length) {
            const re = new RegExp('[ \\t]*' + lines.map(escapeRegExp).join('[ \\t]*\\n[ \\t]*'), 'g');
            const matches = [...src.matchAll(re)];
            if (matches.length === 1) {
                const m = matches[0];
                return { start: m.index, end: m.index + m[0].length };
            }
            if (matches.length > 1) return { error: 'ambiguous' };
        }
        if (prose) {
            const a = normalizeProse(src);
            const look = (f) => {
                const b = normalizeProse(f).text.trim();
                const i = b ? a.text.indexOf(b) : -1;
                if (i < 0) return null;
                if (a.text.indexOf(b, i + 1) >= 0) return { error: 'ambiguous' };
                return { start: a.map[i], end: a.map[i + b.length - 1] + 1 };
            };
            let r = look(find);
            if (r) return r;
            const clean = cleanFindNoise(find);
            const unquoted = !!clean && clean !== find.trim();
            if (unquoted && (r = look(clean))) return r.error ? r : { ...r, unquoted };
            const swapped = swapFirstCase(clean || find);
            if (swapped !== (clean || find) && (r = look(swapped))) return r.error ? r : { ...r, unquoted, caseSwapped: true };
        }
        return { error: 'missing' };
    }

    function swapFirstCase(t) {
        const i = String(t).search(/\p{L}/u);
        if (i < 0) return t;
        const c = t[i], u = c.toUpperCase();
        return t.slice(0, i) + (c === u ? c.toLowerCase() : u) + t.slice(i + 1);
    }

    /* Retrouve un passage recopié par un petit modèle avec une autre typographie ; map[i] : position dans s */
    function normalizeProse(s) {
        const out = [], map = [];
        const push = (c, i) => { out.push(c); map.push(i); };
        const dropSpaces = () => { while (out.length && out[out.length - 1] === ' ') { out.pop(); map.pop(); } };
        s = String(s || '');
        for (let i = 0; i < s.length; i++) {
            let c = s[i];
            if (c === '\\' && i + 1 < s.length && /[!-\/:-@\[-`{-~]/.test(s[i + 1])) continue;
            if (c === '*' || c === '_') continue;
            if (c === '~' && (s[i + 1] === '~' || s[i - 1] === '~')) continue;
            if (c === '«' || c === '“' || c === '„') {
                push('"', i);
                while (i + 1 < s.length && /[ \t   - ]/.test(s[i + 1])) i++;
                continue;
            }
            if (c === '»' || c === '”') { dropSpaces(); push('"', i); continue; }
            if (c === '…') { push('.', i); push('.', i); push('.', i); continue; }
            if (/[‘’‛ʼ]/.test(c)) c = "'";
            else if (/[\t   - ]/.test(c)) c = ' ';
            if (c === ' ') {
                if (!out.length || out[out.length - 1] === ' ' || out[out.length - 1] === '\n') continue;
            } else if (c === '\n') {
                // Ligne vide en plus ou en moins dans le <find> : un seul saut de ligne
                dropSpaces();
                if (out.length && out[out.length - 1] === '\n') continue;
            } else if (c === '\r') continue;
            push(c, i);
        }
        return { text: out.join(''), map };
    }

    // ---------- Tolérance aux erreurs des petits modèles ----------

    function looksComplete(name, content) {
        const s = (content || '').trim();
        if (!s) return false;
        const root = /\.svg$/i.test(name) ? 'svg' : isHtmlFile(name) ? 'html' : null;
        if (root) return !new RegExp('<' + root + '[\\s>]', 'i').test(s) || new RegExp('</' + root + '>$', 'i').test(s);
        if (/\.(css|js|mjs|ts|json)$/i.test(name)) return balanced(s);
        return true;
    }

    function balanced(s) {
        let depth = 0;
        for (const ch of s) {
            if (ch === '{' || ch === '(' || ch === '[') depth++;
            else if (ch === '}' || ch === ')' || ch === ']') depth--;
            if (depth < 0) return false;
        }
        return depth === 0;
    }

    // Raccourci « … reste du code inchangé … » : le fichier n'est pas complet.
    const LAZY_RE = /^[ \t]*(?:\/\/|\/\*|<!--|#)(?=[^\n]*(?:\.\.\.|…))(?=[^\n]*(?:\breste\b|\bsuite\b|\brest\b|inchang|unchanged|existant|existing|précédent|previous|same as))[^\n]*$/im;

    // Canvas : seulement des marqueurs explicites sur une ligne entière ; « # La suite… » n'en est pas un
    const LAZY_DOC_RE = /^[ \t]*(?:[\[(]\s*(?:…|\.\.\.)\s*[\])]|[\[(][^\])\n]*\b(?:reste|suite|rest)\b[^\])\n]*(?:inchang|identique|unchanged)[^\])\n]*[\])]|(?:…|\.\.\.)?[ \t]*[\[(][ \t]*(?:inchangée?s?|identiques?|unchanged)[ \t]*[\])][ \t]*(?:…|\.\.\.)?)[ \t]*$/im;

    // Textes d'exemple des consignes, recopiés tels quels par les petits
    // modèles au lieu d'écrire le vrai contenu.
    const TEMPLATE_TEXTS = new Set(['contenu complet du fichier', 'contenu complet', 'texte complet', 'texte complet, sans rien omettre',
        'texte complet en markdown', 'nouveau passage', 'passage actuel exact', 'passage exact', 'nouveau texte', '…', '...',
        'le passage modifié', 'passage modifié', 'le passage réécrit', 'passage réécrit']);

    /* Un texte vide n'en est pas un : remplacer par rien supprime un passage */
    function isTemplateText(text) {
        const t = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!t) return false;
        return TEMPLATE_TEXTS.has(t) || TEMPLATE_TEXTS.has(t.replace(/[\s.!?;:,]+$/, ''));
    }

    // « bleu ; » n'est pas du code : en français, une espace précède le point-virgule
    const CODE_LINE_RE = /(?:\S;|[{}]|\):)$|^(?:function|def|import|from|const|let|var|class|return|if|elif|else|for|while|export|async|await|try|catch|public|private|#include|package|use)\b|^(?:\/\/|\/\*|\*\/|#!|<\/?[a-z][\w-]*[\s>\/]|<!--)|=>|^[\w.$]+\([^)]*\);?$/;
    const SENTENCE_RE = /^[^;{}()=<>]*\p{L}{2,}[^;{}()=<>]*[.!?…:»"]$/u;

    function looksLikeCode(text) {
        const s = String(text || '').replace(/\r\n/g, '\n');
        if (/^\s*(?:<!doctype\s|<html[\s>]|<\?php|<\?xml)/i.test(s)) return true;
        const lines = s.split('\n').filter(l => l.trim());
        if (!lines.length) return false;
        let code = 0, indented = 0, sentences = 0;
        for (const l of lines) {
            const t = l.trim();
            if (CODE_LINE_RE.test(t)) code++;
            if (/^(?: {2,}|\t)\S/.test(l) && !/^\s*(?:[-*+]|\d+[.)])\s/.test(l)) indented++;
            if (t.split(/\s+/).length >= 5 && SENTENCE_RE.test(t)) sentences++;
        }
        const n = lines.length;
        if (sentences > Math.max(1, n * 0.15)) return false;
        return code >= Math.max(1, n * 0.4) || (code >= 1 && indented >= n * 0.4);
    }

    function guessCodeName(text) {
        const s = String(text || '').trim();
        if (!s) return '';
        if (/^(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html|<html[\s>])/i.test(s)) return 'index.html';
        if (!looksLikeCode(s)) return '';
        if (/^(?:\/\*[\s\S]*?\*\/\s*)*(?:@(?:import|media|charset|font-face|keyframes)|:root|[*.#\w\[][^{};\n]*\{)/.test(s)
            && /[\w-]+\s*:\s*[^;{}\n]+;?\s*(?:\n|\})/.test(s) && !/\bfunction\b|=>|\b(?:const|let|var)\s/.test(s)) return 'style.css';
        if (/\b(?:function|const|let|var|document\.|window\.|addEventListener|console\.)|=>/.test(s)) return 'script.js';
        return '';
    }

    /* Une réécriture d'un texte en garde l'essentiel du vocabulaire (mots d'au moins 5 lettres) */
    function vocabShare(text, ref) {
        const words = t => new Set((String(t || '').toLowerCase().match(/[\p{L}\p{N}]{5,}/gu) || []));
        const r = words(ref);
        if (!r.size) return 1;
        const t = words(text);
        let k = 0;
        for (const w of r) if (t.has(w)) k++;
        return k / r.size;
    }

    // Un infinitif seul (« Comment faire… ? ») n'est pas une demande de création, ni « code » hors de la tête
    const CREATE_ASK_RE = new RegExp('(?:^|[^\\p{L}])(?:cr[ée]e[sz]?|fais|faites|g[ée]n[èe]re[sz]?|[ée]cris|[ée]crivez|construis|construisez|r[ée]alise[sz]?|con[çc]ois|concevez|cod(?:e|ez)-(?:moi|nous)|make|create|build|generate)(?![\\p{L}])'
        + '|^\\s*(?:code[sz]?|programme[sz]?|d[ée]veloppe[sz]?)(?![\\p{L}])'
        + '|(?:peux-tu|pourrais-tu|veux-tu|voudrais-tu|pouvez-vous|pourriez-vous|tu peux|tu pourrais|vous pouvez|j[\'’]aimerais|je voudrais|je veux|aide-moi [àa]|aidez-moi [àa])\\s+(?:me\\s+|m[\'’]\\s*|nous\\s+)?(?:cr[ée]er|faire|g[ée]n[ée]rer|coder|programmer|d[ée]velopper|construire|r[ée]aliser|concevoir|[ée]crire)(?![\\p{L}])', 'iu');
    const QUESTION_ASK_RE = /\?\s*$|^\s*(?:comment|pourquoi|quel(?:le)?s?|qu['’]est-ce|est-ce|combien|o[uù]|quand|que|quoi|peux-tu m['’]expliquer|explique|expliquez|how|why|what|which|when|where)(?![\p{L}])/iu;

    function askKind(userText) {
        const t = String(userText || '').trim();
        if (!t) return '';
        if (CREATE_ASK_RE.test(t)) return 'create';
        return QUESTION_ASK_RE.test(t) ? 'question' : '';
    }

    // Demande de changement même en question, distinguée d'une simple question par importCodeBlocks
    const CHANGE_ASK_RE = new RegExp(
        '(?:^|[^\\p{L}])(?:peux-tu|pourrais-tu|veux-tu|voudrais-tu|tu peux|tu pourrais|tu veux bien|pouvez-vous|pourriez-vous|voulez-vous|vous pouvez|vous pourriez|est-ce que tu (?:peux|pourrais)|est-ce que vous (?:pouvez|pourriez)|j[\'’]aimerais|je voudrais|je veux|il faudrait|il faut|merci de|essaie de|essayez de|can you|could you|please)(?![\\p{L}])'
        + '|^\\s*(?:raccourci[rs]?|raccourcissez|abr[ée]ge[rz]?|condense[rz]?|r[ée]sume[rz]?|rends|rendez|rendre|reformule[rz]?|r[ée][ée]cri[rst]|r[ée][ée]crivez|corrige[rz]?|traduis|traduisez|traduire|change[rz]?|remplace[rz]?|ajoute[rz]?|rajoute[rz]?|enl[èe]ve[rz]?|enlever|retire[rz]?|supprime[rz]?|coupe[rz]?|simplifie[rz]?|d[ée]veloppe[rz]?|allonge[rz]?|am[ée]liore[rz]?|[ée]cris|[ée]crivez|[ée]crire|mets|mettez|mettre|transforme[rz]?|modifie[rz]?|adapte[rz]?|compl[èe]te[rz]?|pr[ée]cise[rz]?|fais|faites|faire|ajuste[rz]?|nuance[rz]?|adoucis|adoucir|renforce[rz]?|structure[rz]?|d[ée]coupe[rz]?|fusionne[rz]?|inverse[rz]?|d[ée]place[rz]?|ins[èe]re[rz]?|garde[rz]?|termine[rz]?|transpose[rz]?|vouvoie|tutoie|shorten|rewrite|rephrase|fix|translate|improve|make|add|remove|delete|change|replace|expand|simplify|correct)(?![\\p{L}])'
        // comparatif ou langue en tête : « plus court », « moins formel », « en anglais »
        + '|^\\s*(?:(?:un peu |beaucoup |encore )?(?:plus|moins)|en (?:anglais|espagnol|allemand|italien|fran[çc]ais|portugais|n[ée]erlandais|arabe|chinois|japonais|russe))(?![\\p{L}])',
        'iu');

    const VOID_TAGS_RE = /^(?:area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i;

    function elementEnd(s, start, tag) {
        const re = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'gi');
        re.lastIndex = start;
        let depth = 0, m;
        while ((m = re.exec(s))) {
            if (m[1]) { if (--depth === 0) return m.index + m[0].length; }
            else if (!m[0].endsWith('/>')) depth++;
        }
        return -1;
    }

    const attrOf = (tag, attr) => {
        const m = new RegExp('\\b' + attr + '\\s*=\\s*["\']([^"\']*)["\']', 'i').exec(tag);
        return m ? m[1] : null;
    };

    /* Remplace l'élément de même id, ou de même balise et classe s'il est seul */
    function mergeHtmlElements(src, piece) {
        const parts = [];
        let i = 0;
        while (i < piece.length) {
            const skip = /^(?:\s+|<!--[\s\S]*?-->)+/.exec(piece.slice(i));
            if (skip) { i += skip[0].length; continue; }
            const open = /^<([a-zA-Z][\w-]*)\b[^>]*>/.exec(piece.slice(i));
            if (!open || VOID_TAGS_RE.test(open[1])) return null;
            const end = elementEnd(piece, i, open[1]);
            if (end < 0) return null;
            parts.push({ tag: open[1], openTag: open[0], html: piece.slice(i, end) });
            i = end;
        }
        if (!parts.length) return null;
        let out = src;
        for (const part of parts) {
            const id = attrOf(part.openTag, 'id');
            const cls = attrOf(part.openTag, 'class');
            let found = [...out.matchAll(new RegExp('<' + part.tag + '\\b[^>]*>', 'gi'))];
            if (id) found = found.filter(m => attrOf(m[0], 'id') === id);
            else if (found.length > 1) found = found.filter(m => attrOf(m[0], 'class') === cls);
            if (found.length !== 1) return null;
            const start = found[0].index;
            const end = elementEnd(out, start, part.tag);
            if (end < 0) return null;
            out = out.slice(0, start) + part.html + out.slice(end);
        }
        return out;
    }

    /* lead : début des commentaires qui précèdent le bloc ; null si illisible */
    function cssBlocks(s) {
        const blocks = [];
        let i = 0;
        while (i < s.length) {
            const lead = i;
            const skip = /^(?:\s+|\/\*[\s\S]*?\*\/)+/.exec(s.slice(i));
            if (skip) i += skip[0].length;
            if (i >= s.length) break;
            const open = s.indexOf('{', i);
            const semi = s.indexOf(';', i);
            if (semi >= 0 && (open < 0 || semi < open)) {
                // Seules les règles @import, @charset… n'ont pas d'accolades
                if (s[i] !== '@') return null;
                blocks.push({ prelude: s.slice(i, semi).trim(), lead, start: i, open: -1, end: semi + 1 });
                i = semi + 1;
                continue;
            }
            if (open < 0) return null;
            let depth = 0, j = open;
            for (; j < s.length; j++) {
                if (s[j] === '{') depth++;
                else if (s[j] === '}' && --depth === 0) break;
            }
            if (j >= s.length) return null;
            blocks.push({ prelude: s.slice(i, open).trim(), lead, start: i, open, end: j + 1 });
            i = j + 1;
        }
        return blocks;
    }

    const cssKey = s => s.replace(/\s+/g, ' ').replace(/\s*([,>+~])\s*/g, '$1').trim().toLowerCase();

    /* Même sélecteur : remplacé ; sinon ajouté à la fin ; @media et @supports fusionnés règle par règle */
    function mergeCssRules(src, piece) {
        const add = cssBlocks(piece);
        if (!add || !add.length || !cssBlocks(src)) return null;
        let out = src;
        const appended = [];
        for (const b of add) {
            const key = cssKey(b.prelude);
            const same = cssBlocks(out).filter(c => cssKey(c.prelude) === key).pop();
            if (!same) { appended.push(piece.slice(b.lead, b.end).trim()); continue; }
            let text = piece.slice(b.start, b.end);
            if (/^@(?:media|supports|container|layer)\b/i.test(b.prelude) && same.open >= 0 && b.open >= 0) {
                const inner = mergeCssRules(out.slice(same.open + 1, same.end - 1), piece.slice(b.open + 1, b.end - 1));
                if (inner !== null) text = out.slice(same.start, same.open + 1) + inner.replace(/\s*$/, '\n') + '}';
            }
            out = out.slice(0, same.start) + text + out.slice(same.end);
        }
        if (appended.length) out = out.replace(/\s*$/, '') + '\n\n' + appended.join('\n\n') + '\n';
        return out;
    }

    /* Morceau sans <find>/<replace> (petits modèles) ; null s'il ne peut pas être placé sans risque */
    function mergeLoose(name, src, piece) {
        src = src.replace(/\r\n/g, '\n');
        piece = piece.replace(/\r\n/g, '\n').trim();
        if (!piece) return null;
        if (isHtmlFile(name)) return /<html[\s>]|<!doctype/i.test(piece) ? piece : mergeHtmlElements(src, piece);
        const ratio = piece.length / Math.max(1, src.trim().length);
        if (/\.css$/i.test(name)) return ratio >= 0.8 && balanced(piece) ? piece : mergeCssRules(src, piece);
        return ratio >= 0.6 && looksComplete(name, piece) ? piece : null;
    }

    function findErrorText(code, name) {
        if (code === 'empty') return `Texte <find> vide pour ${name}`;
        if (code === 'ambiguous') return `Texte <find> présent plusieurs fois dans ${name} : ajoute quelques lignes autour pour qu'il n'y soit qu'une fois`;
        return `Texte <find> non trouvé dans ${name} : copie-le à l'identique depuis le fichier ci-dessus ; si presque tout change, réécris plutôt le fichier entier avec <artifact-file>, en gardant tout ce qui ne change pas`;
    }

    function computeBlock(files, block) {
        const p = block.payload || {};
        const name = p.name;
        const doc = block.family === 'canvas';
        switch (block.kind) {
            case 'file':
                if (!name) return { ok: false, error: 'Balise <artifact-file> sans nom de fichier' };
                if (!doc && isTemplateText(p.content)) {
                    return { ok: false, name, error: `tu as recopié l'exemple de la consigne au lieu d'écrire le contenu de ${name}` };
                }
                if (!doc && name in files && LAZY_RE.test(p.content)) {
                    return { ok: false, name, error: `Contenu incomplet pour ${name} (raccourci du type « … reste du code inchangé … ») : écris le fichier en entier dans <artifact-file>` };
                }
                return { ok: true, name, content: p.content };
            case 'edit': {
                if (!(name in files)) return { ok: false, name, error: `Fichier introuvable : ${name}` };
                let src = files[name].replace(/\r\n/g, '\n');
                for (const pair of p.pairs) {
                    if (isTemplateText(pair.replace)) {
                        return { ok: false, name, error: `tu as recopié l'exemple de la consigne dans <replace> au lieu d'écrire le nouveau texte de ${name}` };
                    }
                    const loc = locateFind(src, pair.find.replace(/\r\n/g, '\n'));
                    if (loc.error) return { ok: false, name, error: findErrorText(loc.error, name) };
                    src = src.slice(0, loc.start) + pair.replace + src.slice(loc.end);
                }
                return { ok: true, name, content: src };
            }
            case 'edit-loose': {
                // <artifact-edit> avec seulement le nouveau contenu (petits modèles)
                if (isTemplateText(p.content)) {
                    return { ok: false, name, error: `tu as recopié l'exemple de la consigne au lieu d'écrire le contenu de ${name}` };
                }
                if (!(name in files)) return p.content ? { ok: true, name, content: p.content } : { ok: false, name, error: `Balise <artifact-edit> vide pour ${name}` };
                const merged = mergeLoose(name, files[name], p.content);
                if (merged === null || LAZY_RE.test(p.content)) {
                    return { ok: false, name, error: `Balise <artifact-edit> sans <find>/<replace> pour ${name} : impossible de savoir quel passage remplacer` };
                }
                return { ok: true, name, content: merged };
            }
            case 'edit-malformed':
                return { ok: false, name, error: `Balise <artifact-edit> mal formée pour ${name} (manque <find>/<replace>)` };
            case 'delete':
                if (!(name in files)) return { ok: false, name, error: `Fichier introuvable : ${name}` };
                return { ok: true, name, content: null };
            default:
                return { ok: false, error: 'Bloc inconnu' };
        }
    }

    // ---------- Texte du Canvas : tolérances propres ----------
    // Bloc ramené par computeDocBlock à un bloc canonique (texte complet), appliqué tel quel à l'état affiché

    const DOC_FIND_ERRORS = {
        empty: 'Texte <find> vide dans <canvas-doc-edit>',
        ambiguous: 'Texte <find> présent plusieurs fois dans le texte du Canvas : ajoute quelques mots autour pour qu\'il n\'y soit qu\'une fois',
        missing: 'Texte <find> non trouvé dans le texte du Canvas : copie-le à l\'identique depuis le texte ci-dessus, ou réécris tout le texte avec <canvas-doc>'
    };
    const DOC_ERRORS = {
        template: 'tu as recopié l\'exemple de la consigne au lieu d\'écrire le texte',
        lazy: 'Texte du Canvas incomplet (« reste inchangé ») : écris-le en entier dans <canvas-doc>, ou modifie seulement un passage avec <canvas-doc-edit>',
        partial: 'tu n\'as réécrit qu\'une partie du texte dans <canvas-doc> : pour changer un passage, utilise <canvas-doc-edit>',
        loose: 'Balise <canvas-doc-edit> sans <find> : impossible de savoir quel passage remplacer. Mets le passage actuel dans <find> et le nouveau dans <replace>, ou réécris tout le texte avec <canvas-doc>',
        malformed: 'Balise <canvas-doc-edit> mal formée (il manque <find> ou <replace>)',
        empty: 'Le Canvas est vide : écris tout le texte avec <canvas-doc>',
        focus: 'Le passage sélectionné n\'est plus dans le texte du Canvas : réécris tout le texte avec <canvas-doc>, ou mets le passage actuel dans <find>'
    };
    // Modification de l'autre espace (une création est rendue dans la réponse)
    const ROUTE_ERRORS = {
        artifacts: 'Cette conversation utilise les Artifacts (code) : le Canvas (texte) n\'y est pas disponible. Pour un texte, écris-le directement dans ta réponse.',
        canvas: 'Cette conversation utilise le Canvas (texte) : les Artifacts (code) n\'y sont pas disponibles. Donne le code dans un bloc ``` de ta réponse.'
    };
    // Mode null : un texte plus court (titres exclus) n'ouvre pas le Canvas, sauf demande ; il reste dans la réponse
    const SHORT_DOC_CHARS = 300;
    const FENCE_LANGS = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', htm: 'html', md: 'markdown', py: 'python', ts: 'typescript', sh: 'bash' };

    /* Clôture plus longue que toute suite d'accents graves du contenu */
    function demotedBlockText(block) {
        const p = block.payload || {};
        const content = String(p.content || '').replace(/\s+$/, '');
        if (!content.trim()) return '';
        if (block.family === 'canvas') return '\n\n' + content + '\n\n';
        const longest = Math.max(2, ...(content.match(/`+/g) || []).map(t => t.length));
        const fence = '`'.repeat(Math.max(3, longest + 1));
        const ext = fileExtension(p.name || '');
        const lang = FENCE_LANGS[ext] || ext;
        return '\n\n' + (p.name ? '`' + p.name + '` :\n\n' : '') + fence + lang + '\n' + content + '\n' + fence + '\n\n';
    }

    // Demande de réduction : une réécriture bien plus courte est alors voulue.
    const REDUCE_RE = /\b(?:résum|raccourci|plus court|condens|abrè?g|synth[eè]s|supprim|enl[eè]v|retir|short|summar)/i;
    // Nombre de caractères d'un texte, titres exclus (garde-fou du mode null).
    const docBodyLength = text => String(text || '').split('\n').filter(l => !/^\s*#/.test(l)).join('\n').trim().length;

    /* À sa place s'il y est encore, sinon là où il apparaît une seule fois */
    function locateFocus(src, focus) {
        if (!focus || typeof focus.excerpt !== 'string' || !focus.excerpt) return null;
        const start = Number(focus.start), end = Number(focus.end);
        if (Number.isFinite(start) && Number.isFinite(end) && src.slice(start, end) === focus.excerpt) return { start, end };
        const loc = locateFind(src, focus.excerpt, true);
        return loc.error ? null : loc;
    }

    /* Mêmes 60 premiers caractères (espaces et casse ignorés) : c'est une réécriture, pas une suite */
    function startsLike(add, src) {
        const norm = t => normalizeProse(t).text.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
        const a = norm(add), b = norm(src);
        return a.length >= 20 && a === b.slice(0, a.length);
    }

    /* Passage sélectionné qui est en fait tout le texte : même début, ou mêmes lignes de bord hors sélection */
    function isWholeRewrite(text, src, focus) {
        const loc = locateFocus(src, focus);
        const start = loc ? loc.start : Number(focus.start), end = loc ? loc.end : Number(focus.end);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
        // (une sélection au tout début du texte peut commencer comme lui)
        if (start >= 80 && startsLike(text, src)) return true;
        const outside = [];
        let pos = 0;
        for (const line of src.split('\n')) {
            const a = pos, b = pos + line.length;
            pos = b + 1;
            if (line.trim().length >= 6 && (b <= start || a >= end)) outside.push(line.trim());
        }
        if (outside.length < 2) return false;
        const lines = new Set(text.split('\n').map(l => l.trim()));
        return lines.has(outside[0]) && lines.has(outside[outside.length - 1]);
    }

    /* Chevauchement répété retiré ; sous 20 caractères, mots entiers seulement ; mot coupé repris remplacé */
    function appendContinuation(src, add) {
        const max = Math.min(src.length, add.length, 2000);
        for (let k = max; k >= 20; k--) {
            if (src.endsWith(add.slice(0, k))) return src + add.slice(k);
        }
        const isL = c => !!c && /[\p{L}\p{N}]/u.test(c);
        for (let k = Math.min(19, max); k >= 4; k--) {
            const piece = add.slice(0, k);
            // Mots entiers : pas de lettre juste après, ni juste avant sauf chevauchement d'au moins 8 caractères
            if (!src.endsWith(piece) || isL(add[k]) || (k < 8 && isL(src[src.length - k - 1]))) continue;
            if (/[\p{L}\p{N}]{4,}/u.test(piece)) return src + add.slice(k);
        }
        const lastWord = /[\p{L}\p{N}]+$/u.exec(src), firstWord = /^[\p{L}\p{N}]+/u.exec(add);
        if (lastWord && firstWord && lastWord[0].length >= 4 && firstWord[0].length >= lastWord[0].length + 2
            && firstWord[0].toLowerCase().startsWith(lastWord[0].toLowerCase())) {
            return src.slice(0, lastWord.index) + add;
        }
        const tail = src.replace(/\s+$/, '');
        // Mot interrompu ou mot suivant : une espace si les deux bouts sont des mots
        const glue = /[\p{L}\p{N},;:.!?»)]$/u.test(src) && /^[\p{L}\p{N}«(]/u.test(add) ? ' ' : '';
        return (tail.length < src.length ? src : src + glue) + add;
    }

    /* Petits modèles : « passage actuel exact : "…" » */
    function cleanFindNoise(find) {
        let t = String(find || '').trim();
        t = t.replace(/^(?:le\s+|la\s+)?(?:passage|texte|extrait|phrase)(?:\s+(?:actuel|exact|original|sélectionné|à\s+modifier))*\s*:\s*/i, '');
        const m = /^["«“]\s*([\s\S]*?)\s*["»”]$/.exec(t);
        return m ? m[1] : t;
    }

    /* Un petit modèle recopie souvent des mots autour du passage dans <find> : remplacés avec lui, ou retirés de rep */
    function replaceFocus(src, sel, find, excerpt, rep) {
        let start = sel.start, end = sel.end;
        const k = find ? find.indexOf(excerpt) : -1;
        if (k >= 0 && find.length > excerpt.length) {
            const pre = find.slice(0, k), post = find.slice(k + excerpt.length);
            const same = (a, b) => a.toLowerCase() === b.toLowerCase();
            if (pre && src.slice(start - pre.length, start) === pre) start -= pre.length;
            else if (pre && same(rep.slice(0, pre.length), pre)) rep = rep.slice(pre.length);
            if (post && src.slice(end, end + post.length) === post) end += post.length;
            else if (post && same(rep.slice(rep.length - post.length), post)) rep = rep.slice(0, rep.length - post.length);
        }
        return src.slice(0, start) + rep + src.slice(end);
    }

    /* Texte du Canvas après un bloc, sans modifier `files` : { ok, error?, demote?, name, block } */
    function computeDocBlock(files, block, ctx) {
        const p = block.payload || {};
        const name = p.name;
        const exists = !!name && name in files;
        const src = exists ? files[name].replace(/\r\n/g, '\n') : '';
        const focus = ctx && ctx.focus && typeof ctx.focus.excerpt === 'string' && ctx.focus.excerpt ? ctx.focus : null;
        const fail = (error) => ({ ok: false, name, error });
        const done = (content) => ({ ok: true, name, block: { kind: 'file', family: 'canvas', payload: { name, content, title: p.title } } });
        // Tout le texte donné pour une sélection : réécriture complète, sinon la lettre se retrouve dans la lettre
        const wholeRewrite = (text) => {
            if (LAZY_DOC_RE.test(text)) return fail(DOC_ERRORS.lazy);
            if (text.trim().length < 0.35 * src.trim().length && !REDUCE_RE.test((ctx && ctx.userText) || '')) return fail(DOC_ERRORS.partial);
            return done(text);
        };
        // `replacement` : texte donné pour la sélection, sa longueur ne suffit pas à en faire une réécriture complète
        const withFocus = (text, replacement = false) => {
            if (!replacement && text.length >= 0.6 * src.length && text.length > 1.5 * focus.excerpt.length) return done(text);
            if (isWholeRewrite(text, src, focus)) return wholeRewrite(text);
            const loc = locateFocus(src, focus);
            return loc ? done(src.slice(0, loc.start) + text + src.slice(loc.end)) : fail(DOC_ERRORS.focus);
        };
        switch (block.kind) {
            case 'file': {
                const text = String(p.content || '').replace(/\r\n/g, '\n');
                if (isTemplateText(text)) return fail(DOC_ERRORS.template);
                // Seconde réécriture du tour bien plus courte (fermante écrite comme une ouvrante) : rendue dans la réponse
                if (ctx && ctx.turnWritten && text.trim().length < 0.35 * ctx.turnWritten) return { ok: false, name, demote: true };
                // Suite d'un texte coupé (reprise automatique)
                if (ctx && ctx.appendDoc && exists && src.trim()) {
                    ctx.appendDoc = false;
                    if (!startsLike(text, src)) return done(appendContinuation(src, text));
                }
                if (focus && exists && src.trim()) return withFocus(text);
                if (exists && LAZY_DOC_RE.test(text)) return fail(DOC_ERRORS.lazy);
                // Réécriture qui ne garde qu'un morceau d'un long texte (petits modèles) : refusée, sauf demande de raccourcir
                if (exists && !p.partial && ctx && ctx.mode === 'canvas' && src.trim().length >= 800
                    && text.trim().length < 0.35 * src.trim().length && !REDUCE_RE.test(ctx.userText || '')) {
                    return fail(DOC_ERRORS.partial);
                }
                return done(text);
            }
            case 'edit': {
                if (!exists) return fail(DOC_ERRORS.empty);
                let out = src;
                // <replace> qui contient tout le texte (passage sélectionné)
                if (focus && p.pairs.length === 1 && src.trim() && isWholeRewrite(p.pairs[0].replace, src, focus)) {
                    return wholeRewrite(p.pairs[0].replace.replace(/\r\n/g, '\n'));
                }
                for (const pair of p.pairs) {
                    if (isTemplateText(pair.replace)) return fail(DOC_ERRORS.template);
                    const find = pair.find.replace(/\r\n/g, '\n');
                    const loc = locateFind(out, find, true);
                    // Passage sélectionné : un <find> trouvé ailleurs n'est pas appliqué, il fait relancer le modèle
                    if (!loc.error && focus && p.pairs.length === 1) {
                        const sel = locateFocus(out, focus);
                        if (sel && (loc.end <= sel.start || loc.start >= sel.end) && !normalizeProse(out.slice(loc.start, loc.end)).text.toLowerCase().includes(normalizeProse(focus.excerpt).text.toLowerCase())) return fail('Ton <find> désigne un autre passage que celui sélectionné (« ' + focus.excerpt.slice(0, 60) + ' ») : recopie dans <find> le passage sélectionné (ou sa phrase entière) et ne change que lui');
                    }
                    if (!loc.error) {
                        let rep = pair.replace;
                        // Passage trouvé sans ses guillemets : le remplacement les perd aussi
                        if (loc.unquoted) {
                            const q = /^\s*["«“]\s*([\s\S]*?)\s*["»”]\s*$/.exec(rep);
                            if (q) rep = q[1];
                        }
                        // Majuscule perdue (ou ajoutée) en tête du <find> : celle du texte
                        if (loc.caseSwapped) {
                            const at = rep.search(/\p{L}/u), src0 = out.slice(loc.start, loc.end).match(/\p{L}/u);
                            if (at >= 0 && src0) {
                                const up = src0[0] === src0[0].toUpperCase() && src0[0] !== src0[0].toLowerCase();
                                rep = rep.slice(0, at) + (up ? rep[at].toUpperCase() : rep[at].toLowerCase()) + rep.slice(at + 1);
                            }
                        }
                        out = out.slice(0, loc.start) + rep + out.slice(loc.end);
                        continue;
                    }
                    // Déjà appliqué (modification périmée ou faite à la main) : le <find> n'est plus là mais le <replace> si
                    if (!focus && loc.error === 'missing' && pair.replace.trim().length >= 4
                        && !locateFind(out, pair.replace.trim(), true).error) continue;
                    // Passage sélectionné : un <find> mal recopié ou trop court (ambigu) désigne la sélection
                    if (focus && p.pairs.length === 1 && loc.error !== 'empty') {
                        const at = Number(focus.start);
                        if (Number.isFinite(at) && find && out.startsWith(find, at)) return done(out.slice(0, at) + pair.replace + out.slice(at + find.length));
                        // <find> recopié avec une étiquette (« passage actuel exact : "…" ») : le passage visé, s'il est dans le texte
                        const clean = cleanFindNoise(find);
                        if (clean && clean !== find) {
                            const l2 = locateFind(out, clean, true);
                            if (!l2.error) return done(out.slice(0, l2.start) + pair.replace + out.slice(l2.end));
                        }
                        // Sinon la sélection, sauf <find> d'un autre passage et remplacement bien plus long : erreur, pas texte abîmé
                        const sel = locateFocus(out, focus);
                        const ex = focus.excerpt;
                        const near = !!clean && (ex.includes(clean) || (clean.includes(ex) && clean.length <= ex.length + 40));
                        if (sel && (near || pair.replace.length <= 2 * ex.length + 40)) return done(replaceFocus(out, sel, clean || find, ex, pair.replace));
                    }
                    return fail(DOC_FIND_ERRORS[loc.error]);
                }
                return done(out);
            }
            case 'edit-replace':
            case 'edit-loose': {
                // Seulement le nouveau texte (<replace> seul, ou rien d'autre)
                const text = String(p.content || '').replace(/\r\n/g, '\n');
                if (!exists) return fail(DOC_ERRORS.empty);
                if (isTemplateText(text)) return fail(DOC_ERRORS.template);
                if (!text.trim() && block.kind === 'edit-loose') return fail(DOC_ERRORS.loose);
                if (focus && src.trim()) return withFocus(text, true);
                if (LAZY_DOC_RE.test(text)) return fail(DOC_ERRORS.lazy);
                if (text.trim().length >= 0.6 * src.trim().length) return done(text);
                return fail(DOC_ERRORS.loose);
            }
            case 'edit-malformed':
                return fail(DOC_ERRORS.malformed);
            default:
                return fail('Bloc inconnu');
        }
    }

    function commitResult(files, result) {
        if (result.content === null) delete files[result.name];
        else files[result.name] = result.content;
    }

    function showSnapshot(snap) {
        // Copie : les versions sont les états enregistrés dans les messages
        state.files = cloneFiles(snap.files);
        if (snap.assets) state.assets = cloneAssets(snap.assets);
        state.entrypoint = snap.entrypoint;
        // Mode de cette version (sans fichier : aucun)
        state.mode = normalizeMode(snap.mode, snap.files, state.mode) || (hasAssets() ? 'artifacts' : null);
        // Canvas : le texte affiché de cette version, s'il existe encore
        if (state.mode === 'canvas' && snap.selectedFile && snap.selectedFile in state.files) state.selectedFile = snap.selectedFile;
        state.docTitles = state.mode === 'canvas' ? titlesFrom(snap, state.files, state.selectedFile) : Object.create(null);
        if (state.selectedFile && !fileExists(state.selectedFile)) {
            state.selectedFile = Object.keys(state.files)[0] || allFileNames()[0] || null;
        }
        state.previewDirty = true;
    }

    function undo() {
        const nav = state.historyNav;
        if (!nav || nav.index <= 0) return false;
        nav.index--;
        showSnapshot(nav.list[nav.index]);
        render();
        return true;
    }

    function redo() {
        const nav = state.historyNav;
        if (!nav || nav.index >= nav.list.length - 1) return false;
        nav.index++;
        showSnapshot(nav.list[nav.index]);
        render();
        return true;
    }

    // ---------- Barre d'historique ----------
    // Barre ouverte : rien n'est enregistré, la conversation garde la version d'avant l'ouverture

    function openHistoryNav() {
        // Pas pendant une réponse de l'IA : elle écrit sur l'état en cours
        if (state.busy && !state.historyNav) return;
        endEditSession();
        state.naming = null;
        state._namingRow = null;
        if (!state.historyNav) {
            state._timeline = null;
            const list = versionTimeline();
            state.historyNav = { list, index: list.current, snap: snapshotState() };
        }
        render();
    }

    /* `apply` : garder la version affichée, sinon revenir à celle d'avant l'ouverture */
    function closeHistoryNav(apply) {
        const nav = state.historyNav;
        if (!nav) return;
        state.historyNav = null;
        if (apply) {
            // La version appliquée devient la référence d'« Afficher les modifications »
            if (!filesEqual(nav.snap.files, state.files)) state.baseline = cloneFiles(state.files);
        } else {
            showSnapshot(nav.snap);
        }
        state._timeline = null;
        render();
        notifyStateChange();
    }

    // ---------- Parser streaming ----------
    // La fin du buffer qui peut commencer une balise est différée (20 caractères au plus)

    /* Retire les sauts de ligne autour du corps (les modèles en mettent presque toujours) */
    function trimBlockBody(body) {
        return body.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    }

    // ---------- Balises canvas dans un bloc de code Markdown ----------
    // Clôture vide autour d'une balise retirée, sinon bloc de code refermé avant le badge

    const FENCE_LINE_RE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
    // Contenu sans importance entre une clôture et la balise : espaces, commentaires
    const JUNK_RE = /^(?:\s|<!--[\s\S]*?-->|\/\*[\s\S]*?\*\/|\/\/[^\n]*)*$/;
    const JUNK_LINE_RE = /^[ \t]*(?:<!--.*-->|\/\*.*\*\/|\/\/.*)[ \t]*$/;
    // Début possible d'un commentaire (dernière ligne encore incomplète)
    const PARTIAL_JUNK_RE = /^[ \t]*(?:<(?:!(?:-(?:-.*)?)?)?|\/(?:\*.*|\/.*)?)$/;

    /* Bloc de code encore ouvert à la fin de `text` : { ch, len, start, empty } ou null */
    function openFenceAtEnd(text) {
        let open = null;
        let pos = 0;
        for (const line of text.split('\n')) {
            const m = FENCE_LINE_RE.exec(line.replace(/\r$/, ''));
            if (m) {
                const ch = m[2][0];
                if (!open) {
                    // Une ouverture ``` ne contient pas d'autre accent grave
                    if (ch !== '`' || m[3].indexOf('`') < 0) {
                        open = { ch, len: m[2].length, indent: m[1].length, start: pos + m[1].length };
                    }
                } else if (ch === open.ch && m[2].length >= open.len && !m[3].trim() && m[1].length <= open.indent + 3) {
                    open = null;
                }
            }
            pos += line.length + 1;
        }
        if (open) {
            const nl = text.indexOf('\n', open.start);
            open.empty = nl < 0 || JUNK_RE.test(text.slice(nl));
        }
        return open;
    }

    function createFenceGuard() {
        // Texte visible déjà émis (badges compris).
        let emitted = '';
        // Clôture neutralisée autour d'une balise ({ ch, len }) : sa ligne de fermeture est à retirer aussi
        let closer = null;

        const lineHead = () => emitted.slice(emitted.lastIndexOf('\n') + 1);

        function dropCloser(text) {
            const head = lineHead();
            const lines = (head + text).split('\n');
            for (let i = 0; i < lines.length; i++) {
                const m = FENCE_LINE_RE.exec(lines[i].replace(/\r$/, ''));
                if (!m) continue;
                const { ch, len } = closer;
                closer = null;
                // Pas une fermeture : un autre bloc commence, la clôture neutralisée n'a jamais été refermée
                if (m[2][0] !== ch || m[2].length < len || m[3].trim()) break;
                // Ligne vidée, pas supprimée : elle sépare ce qui précède (souvent un </html> égaré) de la suite
                lines[i] = i === 0 ? head : '';
                return lines.join('\n').slice(head.length);
            }
            return text;
        }

        return {
            shown: () => emitted,
            text(s) {
                if (closer && s) s = dropCloser(s);
                emitted += s;
                return s;
            },
            /* Texte avant une balise : dans un bloc de code, clôture retirée (bloc vide) ou bloc refermé avant le badge */
            beforeTag(s) {
                if (closer && s) s = dropCloser(s);
                const fence = openFenceAtEnd(emitted + s);
                if (fence) {
                    closer = { ch: fence.ch, len: fence.len };
                    if (fence.empty && fence.start >= emitted.length) {
                        s = s.slice(0, fence.start - emitted.length);
                    } else {
                        // Même indentation que l'ouverture : dans une liste, une
                        // clôture moins indentée ne refermerait pas le bloc.
                        s += ((emitted + s).endsWith('\n') ? '' : '\n') + ' '.repeat(fence.indent) + fence.ch.repeat(fence.len) + '\n';
                    }
                }
                emitted += s;
                return s;
            },
            marker(html) {
                emitted += html;
                return html;
            },
            /* Après un bloc terminé par une clôture ``` (balise jamais fermée) : cette ligne est retirée */
            afterFence(s) {
                if (!closer) s = s.replace(/^[ \t]*(?:`{3,}|~{3,})[ \t]*(?:\n|$)/, '');
                return this.text(s);
            },
            /* Index d'une clôture ``` suivie d'espaces ou commentaires, retenue tant qu'une balise peut suivre ; -1 sinon */
            trailingFence(s, atEnd) {
                const lines = s.split('\n');
                let end = s.length;
                // Dernière ligne incomplète qui peut encore devenir une clôture
                let partial = -1;
                for (let i = lines.length - 1; i >= 0; i--) {
                    const start = end - lines[i].length;
                    const line = lines[i].replace(/\r$/, '');
                    const incomplete = atEnd && i === lines.length - 1;
                    // Une ligne qui prolonge du texte déjà émis n'est ni une clôture ni un commentaire isolé
                    if (start === 0 && /\S/.test(lineHead())) break;
                    if (/^[ \t]*(`{3,}[^`]*|~{3,}.*)$/.test(line)) return start;
                    if (incomplete && line && /^[ \t]*(`{1,2}|~{1,2})?$/.test(line)) partial = start;
                    else if (line.trim() && !JUNK_LINE_RE.test(line) && !(incomplete && PARTIAL_JUNK_RE.test(line))) break;
                    end = start - 1;
                }
                return partial;
            }
        };
    }

    // ---------- Balises tolérantes (petits modèles) ----------
    // Le suffixe donne la famille ; jamais <canvas> seul (élément HTML des jeux)

    const TAG_PREFIX_SRC = '(?:artifacts?|artefacts?|canvas)[-_]';
    // Une valeur entre guillemets doubles peut contenir > ou < (title="Avant > après")
    const TAG_ATTRS_SRC = '((?:"[^"\\n]*"|[^>\\n<])*?)';
    // Demande du guide de DavidTwentyAI : <davidtwentyai-guide /> (ou avec le préfixe des autres balises)
    const OPEN_TAG_RE = new RegExp('^<(?:' + TAG_PREFIX_SRC + '|davidtwentyai[-_](?=guide))(doc[-_]edit|doc[-_]rename|document|doc|file|edit|delete|read|guide)(?![\\w-])' + TAG_ATTRS_SRC + '\\/?>', 'i');
    const CLAUDE_TAG_RE = new RegExp('^<artifacts?(?![\\w-])' + TAG_ATTRS_SRC + '\\/?>', 'i');
    const OPEN_SCAN_RE = new RegExp('<(?:' + TAG_PREFIX_SRC + '|davidtwentyai[-_](?=guide))(?:doc[-_]edit|doc[-_]rename|document|doc|file|edit|delete|read|guide)(?![\\w-])|<artifacts?(?=\\s[^>\\n]*\\btype\\s*=)', 'gi');
    // Débuts possibles d'une balise en fin de buffer (minuscules, « _ » en « - ») : 21 caractères au plus, une balise entière est trouvée par OPEN_SCAN_RE
    const OPEN_TOKENS = [];
    for (const p of ['artifact', 'artifacts', 'artefact', 'artefacts', 'canvas']) {
        for (const x of ['file', 'edit', 'delete', 'read', 'doc', 'document', 'doc-edit', 'doc-rename', 'guide']) OPEN_TOKENS.push('<' + p + '-' + x);
    }
    OPEN_TOKENS.push('<davidtwentyai-guide');
    // Toute fermante connue ferme le bloc (petits modèles) ; </canvas> seul ne ferme qu'un texte du Canvas
    const CLOSE_TAG_SRC = '<\\/\\s*(?:' + TAG_PREFIX_SRC + '(?:doc[-_]edit|document|doc|file|edit)|artifacts?|artefacts?';
    const CLOSE_END_SRC = ')(?:\\s*>|[ \\t]*(?=\\r?\\n))';
    const CLOSE_ANY_RE = new RegExp(CLOSE_TAG_SRC + CLOSE_END_SRC, 'gi');
    const CLOSE_DOC_RE = new RegExp(CLOSE_TAG_SRC + '|canvas' + CLOSE_END_SRC, 'gi');
    // Entre apostrophes, un titre peut en contenir : seule celle suivie d'espace, de / ou de la fin le termine
    const NAME_ATTR_RE = /\b(?:name|path|file|filename)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>\/]+))/i;
    const TITLE_ATTR_RE = /\b(?:title|titre)\s*=\s*(?:"([^"]*)"|'((?:[^']|'(?![\s\/>]|$))*)'|([^\s"'>\/]+))/i;
    // Nouveau titre de <canvas-doc-rename to="…" />
    const TO_ATTR_RE = /\b(?:to|new|nouveau)\s*=\s*(?:"([^"]*)"|'((?:[^']|'(?![\s\/>]|$))*)'|([^\s"'>\/]+))/i;
    // Format de Claude : fichier (ou texte du Canvas) selon le type annoncé
    const CLAUDE_TYPES = { 'text/html': 'index.html', 'text/css': 'style.css', 'application/javascript': 'script.js',
        'text/javascript': 'script.js', 'image/svg+xml': 'image.svg', 'text/markdown': '' };
    const CLAUDE_LANGS = { html: 'index.html', css: 'style.css', javascript: 'script.js', js: 'script.js' };

    /* Balise au format de Claude : { type, name, attrs }, ou null si type inconnu (reste du texte) */
    function claudeTag(s) {
        const m = CLAUDE_TAG_RE.exec(s);
        if (!m) return null;
        const attr = k => { const a = new RegExp('\\b' + k + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>\\/]+))', 'i').exec(m[1]); return a ? (a[1] ?? a[2] ?? a[3]).trim().toLowerCase() : ''; };
        const type = attr('type');
        if (!type) return null;
        if (type === 'text/markdown') return { len: m[0].length, type: 'doc', name: '', attrs: m[1] };
        const name = CLAUDE_TYPES[type] || (type === 'application/vnd.ant.code' ? CLAUDE_LANGS[attr('language')] : '');
        return name ? { len: m[0].length, type: 'file', name, attrs: m[1] } : null;
    }

    // Dialecte sans conversation connue (outils, tests) ; un tour d'IA passe celui de sa conversation
    const DEFAULT_DIALECT = {
        familyOf: (type, name) => (!name || TEXT_FILE_RE.test(name) ? 'canvas' : 'artifacts'),
        docName: (title) => docNameFromTitle(title)
    };

    /* Pour le Canvas, `name` vient de dialect.docName, jamais de la balise (<canvas-doc> n'a pas de nom) */
    function matchOpenTag(s, dialect) {
        let len, type, attrs, rawName;
        const m = OPEN_TAG_RE.exec(s);
        if (m) {
            const suffix = m[1].toLowerCase().replace('_', '-');
            len = m[0].length;
            type = suffix === 'document' ? 'doc' : suffix;
            attrs = m[2];
            const a = NAME_ATTR_RE.exec(attrs);
            rawName = a ? aiFileName(a[1] ?? a[2] ?? a[3]) : '';
        } else {
            // Format de Claude : nom déduit du type annoncé
            const c = /^<artifact/i.test(s) ? claudeTag(s) : null;
            if (!c) return null;
            ({ len, type, attrs } = c);
            rawName = c.name;
        }
        dialect = dialect || DEFAULT_DIALECT;
        const t = TITLE_ATTR_RE.exec(attrs);
        const kind = type === 'doc' ? 'file' : type === 'doc-edit' ? 'edit' : type === 'doc-rename' ? 'rename' : type;
        const family = type === 'doc' || type === 'doc-edit' || type === 'doc-rename' ? 'canvas'
            : type === 'delete' || type === 'read' || type === 'guide' ? 'artifacts' : dialect.familyOf(type, rawName);
        const title = family === 'canvas' && t ? resolveDocTitle(t[1] ?? t[2] ?? t[3], '', '') : '';
        if (kind === 'rename') {
            const to = TO_ATTR_RE.exec(attrs);
            // title : le document visé (par défaut, l'affiché) ; to : son nouveau titre
            return { len, type, kind, family, rawName: '', title, hasTitle: !!t, bare: false, renameTo: to ? (to[1] ?? to[2] ?? to[3]).replace(/\s+/g, ' ').trim() : '',
                name: dialect.docName('', '', title || undefined, kind), range: null };
        }
        return {
            len, type, kind, family, rawName, title, hasTitle: !!t,
            // Sans aucun attribut (« <canvas-doc> ») : peut être une fermante mal écrite
            bare: !/\S/.test(attrs.replace(/\/$/, '')),
            name: family === 'canvas' ? dialect.docName(title, rawName, undefined, kind) : rawName,
            // Lecture d'une partie d'un fichier (lines="120-300")
            range: type === 'read' ? readRangeAttr(attrs) : null
        };
    }

    /* Repère de recherche web inséré par DavidTwentyAI pendant l'écriture (voir streamModel) : hors du fichier */
    function dropSearchAnchors(s) {
        return s.indexOf('web-search-anchor') < 0 ? s : s.replace(/\n*<div class="web-search-anchor"[^>]*><\/div>\n*/g, '\n');
    }

    // Fausse fermante en dernière ligne (« </script-edit> », « </canvas_file> », ou sans « > »)
    const FAKE_CLOSE_RE = /\n?[ \t]*<\/(?:\w+[-_])?(?:canvas[\w-]*|artifacts?[\w-]*|artefacts?[\w-]*|doc[\w-]*|edit|file)>?\s*$/i;

    // Balise HTML qu'un petit modèle laisse autour d'un script ou d'une feuille de style
    const SOURCE_WRAP_TAGS = { js: 'script', mjs: 'script', cjs: 'script', ts: 'script', css: 'style' };

    /* Retire ``` autour du contenu (sauf Markdown des Artifacts ; Canvas : cleanDocBody) et fausse fermante */
    function cleanBlockBody(name, body, family) {
        let s = trimBlockBody(dropSearchAnchors(body)).replace(FAKE_CLOSE_RE, '');
        if (family === 'canvas') return cleanDocBody(s);
        if (!isMarkdownFile(name || '')) {
            const m = /^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n[ \t]*\1[ \t]*$/.exec(s);
            s = m ? m[2] : s.replace(/^[ \t]*(?:`{3,}|~{3,})[\w-]*[ \t]*\n/, '').replace(/\n[ \t]*(?:`{3,}|~{3,})[ \t]*$/, '');
        }
        // Balise HTML laissée autour d'un script ou d'une feuille de style, ou seulement sa fermante
        const wrap = SOURCE_WRAP_TAGS[fileExtension(name || '')];
        if (wrap) {
            s = s.replace(new RegExp('^[ \\t]*<' + wrap + '>[ \\t]*\\n', 'i'), '')
                .replace(new RegExp('\\n?[ \\t]*<\\/' + wrap + '>[ \\t]*$', 'i'), '');
        }
        return s;
    }

    // Délimiteurs du texte dans les consignes du Canvas, parfois recopiés
    const DOC_DELIMITER_RE = /^[ \t]*-{2,}[ \t]*(?:texte du canvas|fin du texte)[ \t]*-{2,}[ \t]*$/i;
    // Langage d'une clôture ``` qui envelopperait tout le texte
    const DOC_FENCE_LANG_RE = /^(?:md|markdown|text|txt)?$/i;

    function stripDocDelimiters(text) {
        const lines = text.split('\n');
        while (lines.length && DOC_DELIMITER_RE.test(lines[0])) lines.shift();
        while (lines.length && DOC_DELIMITER_RE.test(lines[lines.length - 1])) lines.pop();
        return lines.join('\n');
    }

    const DOC_RULE_LINE_RE = /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;

    /* Trait isolé en première ou dernière ligne retiré (petits modèles), sauf en tête de métadonnées YAML */
    function stripEdgeRules(s) {
        const lines = s.split('\n');
        if (lines.length > 1 && DOC_RULE_LINE_RE.test(lines[0]) && !/^[\w-]+[ \t]*:/.test(lines[1])) {
            lines.shift();
            while (lines.length && !lines[0].trim()) lines.shift();
        }
        if (lines.length > 1 && DOC_RULE_LINE_RE.test(lines[lines.length - 1])) {
            lines.pop();
            while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        }
        return lines.join('\n');
    }

    /* Retire délimiteurs recopiés, clôture ``` enveloppant TOUT le texte (petits modèles) et traits isolés aux bords */
    function cleanDocBody(text) {
        let s = stripDocDelimiters(text).replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');
        const blocks = fencedBlocks(s);
        const b = blocks[0];
        if (b && b.start === 0 && !s.slice(b.end).trim() && DOC_FENCE_LANG_RE.test(b.info)) {
            s = stripDocDelimiters(b.body).replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');
        }
        return stripEdgeRules(s);
    }

    /* Même nettoyage en cours d'écriture : clôture ou délimiteur d'ouverture retirés dès qu'ils sont là */
    function cleanPartialDoc(text) {
        let s = text.replace(/^\r?\n/, '');
        for (let i = 0; i < 3; i++) {
            const t = s.replace(/^[ \t]*-{2,}[ \t]*texte du canvas[ \t]*-{2,}[ \t]*\n/i, '')
                .replace(/^[ \t]*(?:`{3,}|~{3,})[ \t]*(?:md|markdown|text|txt)?[ \t]*\n/i, '');
            if (t === s) break;
            s = t;
        }
        return s;
    }

    /* Paires <find>/<replace>, ou seul le nouveau contenu (petits modèles), placé par mergeLoose ou computeDocBlock */
    function editBlock(name, inner, family) {
        inner = dropSearchAnchors(inner);
        let pairs = [];
        const re = /<find>([\s\S]*?)<\/find>[\s\S]*?<replace>([\s\S]*?)<\/replace>/gi;
        let m;
        while ((m = re.exec(inner))) pairs.push({ find: m[1], replace: m[2] });
        const finds = (inner.match(/<find>/gi) || []).length;
        const replaces = (inner.match(/<replace>/gi) || []).length;
        // </replace> oublié (petits modèles) : chaque <replace> va jusqu'au <find> suivant ou la fin du bloc
        if (finds && finds === replaces && (inner.match(/<\/find>/gi) || []).length === finds
            && (inner.match(/<\/replace>/gi) || []).length < replaces) {
            pairs = [];
            const re2 = /<find>([\s\S]*?)<\/find>[\s\S]*?<replace>([\s\S]*?)(<\/replace>|(?=<find>)|$)/gi;
            while ((m = re2.exec(inner))) pairs.push({ find: m[1], replace: m[3] ? m[2] : trimBlockBody(m[2].replace(/[ \t]*$/, '')) });
        }
        if (pairs.length && finds === pairs.length && replaces === pairs.length) {
            // Saut de ligne autour du <find> retiré aussi du <replace>, sinon la recherche tolérante ajoute des lignes vides
            for (const pr of pairs) {
                if (/^\r?\n/.test(pr.find)) { pr.find = pr.find.replace(/^\r?\n/, ''); pr.replace = pr.replace.replace(/^\r?\n/, ''); }
                if (/\r?\n$/.test(pr.find)) { pr.find = pr.find.replace(/\r?\n$/, ''); pr.replace = pr.replace.replace(/\r?\n$/, ''); }
            }
            if (family === 'canvas') {
                // Texte après la dernière </replace> (explication des changements) : rendu au texte visible
                const close = /<\/replace>/gi;
                let after = -1;
                while ((m = close.exec(inner))) after = m.index + m[0].length;
                const tail = after >= 0 ? inner.slice(after).replace(FAKE_CLOSE_RE, '').trim() : '';
                if (tail) return { kind: 'edit', family, rest: '\n\n' + tail, payload: { name, pairs } };
            }
            return { kind: 'edit', family, payload: { name, pairs } };
        }
        if (family === 'canvas' && !finds && replaces === 1) {
            const r = /<replace>([\s\S]*?)(?:<\/replace>|$)/i.exec(inner);
            return { kind: 'edit-replace', family, payload: { name, content: trimBlockBody(r[1]) } };
        }
        if (finds || replaces || /<\/(?:find|replace)>/i.test(inner)) return { kind: 'edit-malformed', family, payload: { name } };
        return { kind: 'edit-loose', family, payload: { name, content: cleanBlockBody(name, inner, family) } };
    }

    // Raison de fin qui signale une réponse coupée par la limite de longueur
    const TRUNCATED_RE = /length|max_tokens|max_output_tokens|incomplete|context_window/i;

    // Dernier paragraphe d'un texte du Canvas qui est en fait l'explication de la réponse
    const FINAL_EXPLAIN_RE = /^(?:Adaptez|Ajustez|Pensez|Personnalisez|Remplacez|Compl[ée]tez|N['’]h[ée]sitez|Vous pouvez|J['’]ai|J['’]esp[èe]re|Voici|Voil[àa]|N['’]h[ée]site|N['’]oublie pas|Dis-moi|Si tu|Souhaites-tu|Tu peux|Bonne lecture|I['’]ve|Let me)(?![\p{L}])/iu;
    // Texte fermé : le paragraphe doit aussi parler des changements (une lettre peut finir par « J'espère… »)
    const META_EXPLAIN_RE = /modifi|chang|ajout|retir|supprim|corrig|reformul|r[ée][ée]cri|r[ée]dig|raccourci|d[ée]velopp|simplifi|adapt|ajust|gard[ée]|conserv|\bton\b|\bstyle\b|version|texte|lettre|n['’]h[ée]site|dis-moi|souhaites|veux-tu|pr[ée]f[èe]res|autre chose|bonne lecture|te pla[iî]|vous pla[iî]|te convien|vous convien/i;

    /* Retire le dernier paragraphe s'il explique la réponse : { body, rest } ; `closed` : balise fermée */
    function splitFinalExplain(text, closed) {
        const trimmed = String(text || '').replace(/\s+$/, '');
        let cut = -1;
        for (const m of trimmed.matchAll(/\n[ \t]*\n/g)) cut = m.index;
        if (cut <= 0) return { body: text, rest: '' };
        const last = trimmed.slice(cut).trim();
        if (!FINAL_EXPLAIN_RE.test(last) || (closed && !META_EXPLAIN_RE.test(last))) return { body: text, rest: '' };
        return { body: trimmed.slice(0, cut), rest: trimmed.slice(cut) };
    }

    /* onBlock renvoie le badge (chaîne ou { html, always }) ; dialect : voir matchOpenTag */
    function createStreamParser(onBlock, onProgress, dialect) {
        dialect = dialect || DEFAULT_DIALECT;
        let buf = '';
        // Derniers caractères déjà sortis du buffer (balise citée entre `, ou début de sa ligne)
        let consumed = '';
        let lastProgressKey = '';
        // Badge déjà émis pendant le streaming du bloc : pas de second à sa fermeture
        let currentBlockMarkerEmitted = false;
        let tagOpen = false;
        const guard = createFenceGuard();
        const openTag = s => matchOpenTag(s, dialect);

        function findNextOpenIdx(s, from) {
            OPEN_SCAN_RE.lastIndex = from;
            const m = OPEN_SCAN_RE.exec(s);
            return m ? m.index : -1;
        }

        /* Balise citée dans une phrase (petits modèles) : true, false, ou null tant que la suite manque */
        function mentionAt(s, idx, final, prefix) {
            const tail = s.slice(idx);
            // Entre `…` (mais pas ``` qui ouvre un bloc) ; `prefix` : caractères déjà sortis du buffer
            const lead = ((prefix || '') + s.slice(Math.max(0, idx - 3), idx)).slice(-3);
            const ticked = lead.slice(-1) === '`' && lead !== '```';
            const o = openTag(tail);
            // Pas encore une balise complète : on tranche dès qu'elle ne peut plus le devenir
            if (!o) return final || /[>\n<]/.test(tail.slice(1)) ? true : null;
            // Nom d'exemple recopié : name="…"
            if (o.rawName && /^[.…\s]+$/.test(o.rawName)) return true;
            // Renommage : réel hors de `…`, sauf le titre d'exemple recopié
            if (o.kind === 'rename') return ticked || !o.renameTo || /^(?:nouveau titre|[.…\s]+)$/i.test(o.renameTo);
            if (o.family === 'canvas') {
                const head = (prefix || '') + s.slice(0, idx);
                return docMentionAt(tail, o, ticked, final, head.slice(head.lastIndexOf('\n') + 1));
            }
            if (ticked && !o.name) return true;
            if (!ticked && o.name) return false;
            // Demande du guide : toujours réelle hors de `…`
            if (o.kind === 'guide') return false;
            // Balise nommée entre ` ou sans nom : la suite de la ligne décide (une phrase qui continue = citation)
            let after = tail.slice(o.len);
            if (after[0] === '`') after = after.slice(1);
            const next = /^[ \t]*([^ \t])/.exec(after);
            if (!next) return final ? ticked : null;
            if (ticked) return next[1] !== '\n' && next[1] !== '\r';
            return o.kind !== 'delete' && o.kind !== 'read' && o.kind !== 'guide' && /[\p{L},.;:!?)»"']/u.test(next[1]);
        }

        /* Canvas : réelle si titre ou fin de ligne vide ; collée à du texte, une fermante ou la fin du flux tranche */
        function docMentionAt(tail, o, ticked, final, lineBefore) {
            if (ticked) return true;
            const q = quotedSample(tail, o, lineBefore, final);
            if (q !== false) return q;
            if (o.hasTitle) return false;
            const after = tail.slice(o.len);
            const line = /^[ \t]*(\r?\n|<|[^ \t])/.exec(after);
            if (!line) return final ? true : null;
            if (line[1] !== '<' && line[1].trim()) {
                // Texte collé à la balise : la suite tranche
                CLOSE_DOC_RE.lastIndex = o.len;
                const close = CLOSE_DOC_RE.exec(tail);
                const nextOpen = findNextOpenIdx(tail, o.len);
                if (close && (nextOpen < 0 || close.index < nextOpen)) return false;
                if (nextOpen >= 0 || final) return true;
                return null;
            }
            return false;
        }

        /* Balise du Canvas ouverte et fermée sur une ligne au milieu d'une phrase : citée (null si ligne inachevée) */
        function quotedSample(tail, o, lineBefore, final) {
            if (!/\p{L}/u.test(lineBefore || '')) return false;
            const nl = tail.indexOf('\n');
            const line = nl < 0 ? tail : tail.slice(0, nl);
            CLOSE_DOC_RE.lastIndex = o.len;
            const close = CLOSE_DOC_RE.exec(line);
            // Ligne pas finie : la fermante peut encore venir (sinon la balise, jugée réelle trop tôt, le resterait)
            if (!close) return nl < 0 && !final ? null : false;
            const inner = line.slice(o.len, close.index);
            const parts = o.type === 'doc-edit' ? [...inner.matchAll(/<(find|replace)>([\s\S]*?)<\/\1>/gi)].map(m => m[2]) : [inner];
            if (o.type === 'doc-edit' && !parts.length && inner.trim()) return false;
            if (!parts.every(t => !t.trim() || isTemplateText(t))) return false;
            if (line.slice(close.index + close[0].length).trim()) return true;
            return nl < 0 && !final ? null : false;
        }

        /* Prochaine vraie balise hors citations : { idx, pending } ; idx = -1 si aucune */
        function nextTag(s, from, final, prefix) {
            for (let i = from; ;) {
                const idx = findNextOpenIdx(s, i);
                if (idx < 0) return { idx: -1, pending: false };
                const m = mentionAt(s, idx, final, prefix);
                if (m === false) return { idx, pending: false };
                if (m === null) return { idx, pending: true };
                i = idx + 1;
            }
        }

        /* Index d'un '<' pouvant commencer une balise, pour différer la fin du buffer */
        function findTrailingSuspicious(s) {
            const max = Math.min(s.length, 20);
            for (let i = s.length - 1; i >= s.length - max && i >= 0; i--) {
                if (s[i] === '<') {
                    const rest = s.slice(i).toLowerCase().replace(/_/g, '-');
                    for (const tok of OPEN_TOKENS) {
                        if (tok.startsWith(rest)) return i;
                    }
                }
            }
            // Balise au format de Claude dont les attributs arrivent encore (son type décide)
            const claude = /<artifacts?\s[^>\n]{0,240}$/i.exec(s);
            if (claude) return claude.index;
            return -1;
        }

        /* Fin du corps : fermante connue (les petits modèles les confondent) ou, jamais fermé, début d'une autre balise */
        function findBodyEnd(s, from, family, doc) {
            const re = family === 'canvas' ? CLOSE_DOC_RE : CLOSE_ANY_RE;
            re.lastIndex = from;
            const close = re.exec(s);
            const next = nextTag(s, from, false);
            if (next.idx >= 0 && (!close || next.idx < close.index)) {
                if (next.pending) return null;
                const len = doc ? bareCloserAt(s, from, next.idx) : 0;
                return { at: next.idx, after: next.idx + len };
            }
            return close ? { at: close.index, after: close.index + close[0].length } : null;
        }

        /* Fermante écrite comme une ouvrante (« <canvas-doc> » nu en début de ligne) : sa longueur, 0 sinon */
        function bareCloserAt(s, from, idx) {
            const before = s.slice(from, idx);
            if (!/(?:^|\n)[ \t]*$/.test(before) || !before.trim()) return 0;
            const o = openTag(s.slice(idx));
            return o && o.type === 'doc' && o.bare ? o.len : 0;
        }

        /* Extrait UNE balise complète à buf[start], ou null si incomplète (le flush final décide) */
        function tryExtractAt(start, final = false) {
            const tail = buf.slice(start);
            const o = openTag(tail);
            if (!o) return null;
            if (o.kind === 'delete' || o.kind === 'read' || o.kind === 'guide' || o.kind === 'rename') {
                // Peut-être une fermante superflue qui arrive : on l'attend
                if (!final && /^\s*(?:<(?:\/[\w-]*)?)?$/.test(tail.slice(o.len))) return null;
                // « </artifact-delete> » (ou « </artifact-read> », « </davidtwentyai-guide> ») superflu juste après : consommé aussi
                const extra = new RegExp('^\\s*<\\/\\s*(?:' + TAG_PREFIX_SRC + '|davidtwentyai[-_])' + o.type.replace('-', '[-_]') + '\\s*>', 'i').exec(tail.slice(o.len));
                const end = start + o.len + (extra ? extra[0].length : 0);
                if (o.kind === 'guide') return { kind: 'guide', family: 'artifacts', end, payload: {} };
                if (o.kind === 'rename') return { kind: 'rename', family: 'canvas', end, payload: { name: o.name, title: o.renameTo, from: o.title } };
                if (o.kind === 'read') return { kind: 'read', family: 'artifacts', end, payload: { name: o.name, range: o.range } };
                return { kind: 'delete', family: 'artifacts', end, payload: { name: o.name } };
            }
            const e = findBodyEnd(tail, o.len, o.family, o.type === 'doc');
            if (!e) return null;
            const body = tail.slice(o.len, e.at);
            if (o.kind === 'file') {
                let content = cleanBlockBody(o.name, body, o.family), rest = '';
                // Texte du Canvas : l'explication écrite avant la fermante est rendue au texte visible
                if (o.family === 'canvas') ({ body: content, rest } = splitFinalExplain(content, true));
                return { kind: 'file', family: o.family, tag: o.type, rawName: o.rawName, end: start + e.after, rest, payload: { name: o.name, content, title: o.title } };
            }
            return Object.assign(editBlock(o.name, body, o.family), { end: start + e.after });
        }

        /* Bloc resté ouvert en fin de flux : corps jusqu'à la fin ou une clôture ``` ; `rest` redevient visible */
        function unclosedBlockAt(start) {
            const tail = buf.slice(start);
            const o = openTag(tail);
            if (!o || !o.name || o.kind === 'delete' || o.kind === 'read' || o.kind === 'rename') return null;
            let body = tail.slice(o.len), rest = '';
            if (o.family === 'canvas') {
                // Fermante écrite comme une ouvrante, suivie de texte sur sa ligne
                if (o.type === 'doc') {
                    const re = /\n[ \t]*(?=<)/g;
                    for (let m; (m = re.exec(body));) {
                        const at = m.index + m[0].length;
                        const len = bareCloserAt(body, 0, at);
                        if (len) { rest = body.slice(at + len); body = body.slice(0, at); break; }
                    }
                }
                // Clôture ``` orpheline (nombre impair, la dernière sans langage) : le modèle a « fermé » son texte ainsi
                if (!rest) {
                    const fences = [...body.matchAll(/\n[ \t]*(?:`{3,}|~{3,})([^\n]*)(?=\n|$)/g)];
                    const last = fences[fences.length - 1];
                    if (last && fences.length % 2 === 1 && !last[1].trim()) { rest = body.slice(last.index + last[0].length); body = body.slice(0, last.index); }
                }
                if (!rest) ({ body, rest } = splitFinalExplain(body, false));
            } else if (!isMarkdownFile(o.name)) {
                const first = body.search(/\S/);
                const re = /\n[ \t]*(?:`{3,}|~{3,})[ \t]*(?=\n|$)/g;
                re.lastIndex = Math.max(0, body.indexOf('\n', first));
                const f = re.exec(body);
                if (f) { rest = body.slice(f.index + 1); body = body.slice(0, f.index); }
            }
            const block = o.kind === 'file'
                ? { kind: 'file', family: o.family, tag: o.type, rawName: o.rawName, payload: { name: o.name, content: cleanBlockBody(o.name, body, o.family), title: o.title } }
                : editBlock(o.name, body, o.family);
            // Explication écrite après la dernière </replace> (voir editBlock)
            if (block.rest) { rest = block.rest + rest; delete block.rest; }
            return { block, rest };
        }

        /* Progression d'un bloc encore ouvert : { kind, family, name, partial }, ou null */
        function tryExtractProgressAt(start) {
            const tail = buf.slice(start);
            const o = openTag(tail);
            if (!o || !o.name) return null;
            if (o.kind === 'file') {
                let body = tail.slice(o.len);
                const e = findBodyEnd(body, 0, o.family, o.type === 'doc');
                if (e) body = body.slice(0, e.at);
                if (o.family === 'canvas') body = cleanPartialDoc(body);
                else {
                    body = body.replace(/^\r?\n/, '');
                    if (!isMarkdownFile(o.name)) body = body.replace(/^[ \t]*(?:`{3,}|~{3,})[\w-]*[ \t]*\n/, '');
                }
                return { kind: 'file', family: o.family, tag: o.type, rawName: o.rawName, name: o.name, partial: body, title: o.title };
            }
            if (o.kind === 'edit') {
                // Édition : contenu final inconnu tant que find/replace sont incomplets, seul le nom anime le fichier
                return { kind: 'edit', family: o.family, name: o.name, partial: null };
            }
            return null;
        }

        /* onBlock peut renvoyer { html, always: true } : marqueur émis même après un badge (échec, bloc rendu au texte) */
        function emitBlock(block) {
            let marker = '';
            let always = false;
            try {
                const ret = onBlock(block);
                if (typeof ret === 'string') marker = ret;
                else if (ret && typeof ret.html === 'string') { marker = ret.html; always = !!ret.always; }
            } catch (e) { console.error('[canvas] onBlock error:', e); }
            const out = marker && (always || !currentBlockMarkerEmitted) ? guard.marker(marker) : '';
            currentBlockMarkerEmitted = false;
            tagOpen = false;
            lastProgressKey = '';
            return out;
        }

        function feed(chunk) {
            buf += chunk;
            let visible = '';
            let cursor = 0;

            while (cursor < buf.length) {
                const next = nextTag(buf, cursor, false, consumed);
                const openIdx = next.idx;
                if (openIdx < 0) {
                    // Fin retenue : un début de balise, ou une clôture ``` qui entoure peut-être la balise suivante
                    const rest = buf.slice(cursor);
                    let end = findTrailingSuspicious(rest);
                    if (end < 0) end = rest.length;
                    const fenceIdx = guard.trailingFence(rest.slice(0, end), end === rest.length);
                    if (fenceIdx >= 0) end = fenceIdx;
                    visible += guard.text(rest.slice(0, end));
                    cursor += end;
                    break;
                }
                // Balise peut-être citée dans une phrase : on attend quelques caractères pour trancher
                if (next.pending) {
                    // Le texte qui précède peut sortir (une balise collée à du texte fait attendre), sauf une clôture ``` retenue
                    if (!tagOpen && openIdx > cursor) {
                        const pre = buf.slice(cursor, openIdx);
                        let end = guard.trailingFence(pre, false);
                        if (end < 0) end = pre.length;
                        visible += guard.text(pre.slice(0, end));
                        cursor += end;
                    }
                    break;
                }
                if (!tagOpen) {
                    visible += guard.beforeTag(buf.slice(cursor, openIdx));
                    cursor = openIdx;
                    tagOpen = true;
                }
                const extracted = tryExtractAt(cursor);
                if (!extracted) {
                    // Balise incomplète : on attend la suite, mais onProgress affiche déjà le fichier en cours d'écriture
                    if (onProgress) {
                        const prog = tryExtractProgressAt(cursor);
                        if (prog) {
                            // Clé de dédup : pas d'appel à onProgress à chaque caractère si rien d'utile n'a changé
                            const key = prog.kind + '|' + prog.name + '|' + (prog.partial ? prog.partial.length : 0);
                            const isFirst = !currentBlockMarkerEmitted;
                            if (isFirst || key !== lastProgressKey) {
                                lastProgressKey = key;
                                let progRet;
                                try {
                                    progRet = onProgress({
                                        kind: prog.kind,
                                        family: prog.family,
                                        tag: prog.tag,
                                        rawName: prog.rawName,
                                        name: prog.name,
                                        title: prog.title,
                                        partial: prog.partial,
                                        firstTime: isFirst
                                    });
                                } catch (e) { console.error('[canvas] onProgress error:', e); }
                                // Badge renvoyé par le premier onProgress émis aussitôt : il apparaît dès le début de la génération
                                if (isFirst && typeof progRet === 'string' && progRet) {
                                    visible += guard.marker(progRet);
                                    currentBlockMarkerEmitted = true;
                                }
                            }
                        }
                    }
                    break;
                }
                // Badge injecté à la position exacte du bloc, puis l'explication sortie du texte du Canvas
                visible += emitBlock(extracted);
                if (extracted.rest) visible += guard.text(extracted.rest);
                cursor = extracted.end;
            }

            consumed = (consumed + buf.slice(0, cursor)).slice(-240);
            buf = buf.slice(cursor);

            return { visible };
        }

        /* Bloc jamais fermé : appliqué si réponse finie et complète, gardé si texte du Canvas coupé, sinon abandonné */
        function flush(usage) {
            const remaining = buf;
            const openIdx = nextTag(remaining, 0, true, consumed).idx;
            const cutAt = openIdx >= 0 ? openIdx : findTrailingSuspicious(remaining);
            let visible = guard.text(cutAt >= 0 ? remaining.slice(0, cutAt) : remaining);
            let cut = null;
            // Balise sans contenu (guide, lecture, suppression) en toute fin de réponse : appliquée, avec ce qui suit
            const solo = openIdx >= 0 ? tryExtractAt(openIdx, true) : null;
            if (solo && (solo.kind === 'guide' || solo.kind === 'read' || solo.kind === 'delete' || solo.kind === 'rename')) {
                visible += emitBlock(solo) + guard.text(remaining.slice(solo.end));
                buf = '';
                return { visible, cut };
            }
            if (openIdx >= 0) {
                const unclosed = unclosedBlockAt(openIdx);
                const block = unclosed && unclosed.block;
                const finish = usage && usage.finish_reason;
                const finished = !!finish && !TRUNCATED_RE.test(finish) && !usage.stream_error;
                const complete = block && (block.kind === 'edit' || (block.kind !== 'edit-malformed' && looksComplete(block.payload.name, block.payload.content)));
                if (finished && complete) {
                    visible += emitBlock(block);
                    if (unclosed.rest) visible += guard.afterFence(unclosed.rest);
                } else if (block && block.family === 'canvas' && block.kind === 'file' && block.payload.content.trim()) {
                    // Texte coupé : la partie écrite est gardée
                    block.payload.partial = true;
                    visible += emitBlock(block);
                    cut = { kind: 'file', family: 'canvas', name: block.payload.name, partial: true };
                } else {
                    const prog = tryExtractProgressAt(openIdx);
                    cut = { kind: prog ? prog.kind : null, family: prog ? prog.family : null, name: prog ? prog.name : null };
                }
            }
            buf = '';
            return { visible, cut };
        }

        /* Bloc venu d'un appel d'outil, déjà décodé : même traitement qu'une balise fermée */
        function inject(block) {
            return emitBlock(block);
        }

        /* Fichier écrit par un appel d'outil : badge dès le début (un seul par fichier), puis badge d'erreur si échec */
        function injectProgress(info) {
            let ret = '';
            try { if (onProgress) ret = onProgress({ ...info, firstTime: true, viaTool: true }); } catch (e) { console.error('[canvas] onProgress error:', e); }
            return typeof ret === 'string' && ret ? guard.marker(ret) : '';
        }

        /* Badge qui termine ce qui est déjà affiché ; undefined tant que rien ne l'est */
        function lastBadgeKey() {
            const shown = guard.shown();
            return /\S/.test(shown) ? trailingBadgeKey(shown) : undefined;
        }

        return { feed, flush, inject, injectProgress, lastBadgeKey, marker: html => guard.marker(html) };
    }

    // ---------- Badge inline pour le message IA ----------

    const INLINE_OP_ICONS = {
        create: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>',
        edit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
        delete: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>',
        read: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>'
    };

    function inlineOpLabel(kind, name, space, docLabel) {
        if (space === 'canvas' && docLabel) return kind === 'create' ? `Rédaction de « ${docLabel} »` : `Modification de « ${docLabel} »`;
        if (space === 'canvas') return kind === 'create' ? 'Rédaction du texte' : 'Modification du texte';
        if (kind === 'create') return `Création de ${name}`;
        if (kind === 'delete') return `Suppression de ${name}`;
        return `Modification de ${name}`;
    }

    /* Deux sauts de ligne : marked.parse en fait un bloc HTML autonome ; data-space sert au clic et à l'historique */
    function buildInlineOpMarker(name, block, existedBefore, docLabel) {
        if (!name) return '';
        let kind = null;
        if (block.kind === 'file' || block.kind === 'edit-loose' || block.kind === 'edit-replace') kind = existedBefore ? 'edit' : 'create';
        else if (block.kind === 'edit') kind = 'edit';
        else if (block.kind === 'delete') kind = 'delete';
        else return '';
        const space = block.family === 'canvas' ? 'canvas' : 'artifacts';
        const icon = INLINE_OP_ICONS[kind];
        const label = escapeHtml(inlineOpLabel(kind, name, space, docLabel));
        const safeName = escapeHtml(name);
        return `\n\n<div class="canvas-inline-op canvas-inline-op-${kind}" data-name="${safeName}" data-kind="${kind}" data-space="${space}"><span class="canvas-inline-op-icon">${icon}</span><span class="canvas-inline-op-label">${label}</span></div>\n\n`;
    }

    const INLINE_ERROR_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

    function buildInlineErrorMarker(label, space) {
        const sp = space === 'canvas' || space === 'artifacts' ? ` data-space="${space}"` : '';
        return `\n\n<div class="canvas-inline-op canvas-inline-op-error" data-kind="error"${sp}><span class="canvas-inline-op-icon">${INLINE_ERROR_ICON}</span><span class="canvas-inline-op-label">${escapeHtml(label)}</span></div>\n\n`;
    }

    function buildInlineReadMarker(name, range, exists) {
        if (!name) return '';
        if (!exists) return buildInlineErrorMarker(`Lecture impossible : ${name} n'existe pas`, 'artifacts');
        const label = escapeHtml(`Lecture de ${name}` + (range ? ` (lignes ${range.from} à ${range.to})` : ''));
        return `\n\n<div class="canvas-inline-op canvas-inline-op-read" data-name="${escapeHtml(name)}" data-kind="read" data-space="artifacts"><span class="canvas-inline-op-icon">${INLINE_OP_ICONS.read}</span><span class="canvas-inline-op-label">${label}</span></div>\n\n`;
    }

    /* Renommage par balise ; jamais recopié pour l'IA (le titre à jour est dans l'état du Canvas) */
    function buildInlineRenameMarker(name, title) {
        const label = escapeHtml(`Titre changé : « ${title} »`);
        return `\n\n<div class="canvas-inline-op canvas-inline-op-edit" data-name="${escapeHtml(name)}" data-kind="rename" data-space="canvas"><span class="canvas-inline-op-icon">${INLINE_OP_ICONS.edit}</span><span class="canvas-inline-op-label">${label}</span></div>\n\n`;
    }

    // Sans data-name : ni ouvert au clic, ni recopié pour l'IA
    const CONSOLE_READ_MARKER = `\n\n<div class="canvas-inline-op canvas-inline-op-read" data-kind="console" data-space="artifacts"><span class="canvas-inline-op-icon">${INLINE_OP_ICONS.read}</span><span class="canvas-inline-op-label">Lecture de la console</span></div>\n\n`;

    /** Badge d'erreur pour un bloc resté inachevé (voir `getCut` du parser). */
    function buildCutMarker(cut) {
        if (cut && cut.family === 'canvas') {
            if (cut.partial) return buildInlineErrorMarker('Texte du Canvas incomplet : la réponse s\'est arrêtée avant la fin', 'canvas');
            if (cut.kind === 'edit') return buildInlineErrorMarker('Modification du texte du Canvas non appliquée : la réponse s\'est arrêtée avant la fin', 'canvas');
            return buildInlineErrorMarker('Texte du Canvas non enregistré : la réponse s\'est arrêtée avant la fin', 'canvas');
        }
        if (!cut || !cut.name) return buildInlineErrorMarker('Réponse arrêtée avant la fin d\'un fichier : il n\'a pas été enregistré');
        if (cut.kind === 'edit') return buildInlineErrorMarker(`Modification de ${cut.name} non appliquée : la réponse s'est arrêtée avant la fin`, 'artifacts');
        return buildInlineErrorMarker(`${cut.name} non enregistré : la réponse s'est arrêtée avant la fin du fichier`, 'artifacts');
    }

    /* Retire les badges de création/modification des fichiers `names` (tous en échec : le badge d'erreur reste) */
    function dropOpBadges(text, names) {
        if (typeof text !== 'string' || !names || !names.length) return text;
        const set = new Set(names.map(n => escapeHtml(n)));
        return text.replace(INLINE_OP_RE, m => {
            const kind = /data-kind="([^"]*)"/.exec(m);
            const name = /data-name="([^"]*)"/.exec(m);
            return kind && kind[1] !== 'error' && kind[1] !== 'delete' && kind[1] !== 'read' && name && set.has(name[1]) ? '' : m;
        }).replace(/\n{3,}/g, '\n\n');
    }

    /* Badge « Création de… » d'un bloc inachevé, toujours en fin de texte : retiré, sauf texte du Canvas coupé */
    function dropCutMarker(text, cut) {
        if (typeof text !== 'string') return text;
        const trimmed = text.replace(/\s+$/, '');
        if (!cut || !cut.name || cut.partial) return trimmed;
        const start = trimmed.lastIndexOf('<div class="canvas-inline-op');
        if (start < 0) return trimmed;
        const tail = trimmed.slice(start);
        const name = /data-name="([^"]*)"/.exec(tail);
        if (!name || name[1] !== escapeHtml(cut.name) || !/<\/span><\/div>$/.test(tail)) return trimmed;
        return trimmed.slice(0, start).replace(/\s+$/, '');
    }

    const INLINE_OP_RE = /<div class="canvas-inline-op[^"]*"[^>]*>[\s\S]*?<span class="canvas-inline-op-label">[\s\S]*?<\/span><\/div>/g;

    // Création et modification d'un fichier partagent leur clé ; suppression, lecture et renommage ont la leur
    const badgeKey = (kind, name) => (kind === 'delete' || kind === 'read' || kind === 'rename' ? kind + ':' : '') + name;

    function badgeKeys(text) {
        const keys = [];
        for (const m of String(text || '').matchAll(INLINE_OP_RE)) {
            const kind = /data-kind="([^"]*)"/.exec(m[0]);
            const name = /data-name="([^"]*)"/.exec(m[0]);
            if (kind && name && kind[1] !== 'error') keys.push(badgeKey(kind[1], unescapeHtml(name[1])));
        }
        return keys;
    }

    /* Clé du badge qui termine `text`, suivi seulement d'espaces ; null si autre chose vient après (texte, badge d'erreur) */
    function trailingBadgeKey(text) {
        const s = String(text || '').replace(/\s+$/, '');
        const tail = s.slice(s.lastIndexOf('<div class="canvas-inline-op'));
        const m = new RegExp(INLINE_OP_RE.source).exec(tail);
        if (!m || m.index !== 0 || m[0].length !== tail.length) return null;
        const keys = badgeKeys(m[0]);
        return keys.length === 1 ? keys[0] : null;
    }

    /* Anciennes réponses au badge resté dans un bloc de code : clôtures retirées à l'affichage et pour l'IA */
    function unfenceMarkers(text) {
        if (typeof text !== 'string' || text.indexOf('canvas-inline-op') < 0 || !/```|~~~/.test(text)) return text;
        const guard = createFenceGuard();
        let out = '';
        let last = 0;
        for (const m of text.matchAll(INLINE_OP_RE)) {
            out += guard.beforeTag(text.slice(last, m.index)) + guard.marker(m[0]);
            last = m.index + m[0].length;
        }
        return out + guard.text(text.slice(last));
    }

    // Placeholder recopié de l'historique (actuels, ou ancien « [contenu enregistré dans le canvas] »)
    const PLACEHOLDER_RE = /^\[(?:contenu|modification|texte) enregistr[ée]+[^\]]*\]$/i;
    // Début d'un tel contenu (bloc en cours d'écriture)
    const PLACEHOLDER_START_RE = /^\[(?:contenu|modification|texte) enregistr/i;

    function unescapeHtml(s) {
        return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    }

    // Mention recopiée au lieu d'une vraie balise, ou annotation « (DavidTwentyAI : …) » : le modèle croit avoir modifié
    const FAKE_MENTION_SRC = '\\[(?:Canvas|Artifacts?|Artefacts?)\\s*:[^\\]]*\\]|\\[l[\'’]assistant a [^\\]\\n]*\\]|\\((?:DavidTwentyAI|Note de l\'application)\\s*:[^)]*\\)';
    const FAKE_OP_RE = new RegExp(FAKE_MENTION_SRC, 'i');

    /* Affichage : mentions recopiées masquées, aussi en cours d'écriture (« [l'assistant a » pas encore fermé) */
    function hideFakeMentions(text) {
        if (typeof text !== 'string' || (text.indexOf('[') < 0 && text.indexOf('(') < 0)) return text;
        let out = text.replace(new RegExp(FAKE_MENTION_SRC, 'gi'), '');
        const tail = /\[([^\]\n]{0,120})$/.exec(out);
        if (tail) {
            const s = tail[1].replace(/’/g, "'").toLowerCase();
            if ("l'assistant a ".startsWith(s) || s.startsWith("l'assistant a ")) out = out.slice(0, tail.index);
        }
        return out;
    }

    function stripFakeMentions(text) {
        return text
            .replace(new RegExp(FAKE_MENTION_SRC, 'gi'), '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    /* Espace d'un badge : data-space, sinon (anciennes réponses) le mode de la conversation, sinon l'extension */
    function badgeSpace(badge, name, mode) {
        const sp = /data-space="([^"]*)"/.exec(badge);
        if (sp && (sp[1] === 'artifacts' || sp[1] === 'canvas')) return sp[1];
        if (mode === 'artifacts' || mode === 'canvas') return mode;
        return TEXT_FILE_RE.test(name) ? 'canvas' : 'artifacts';
    }

    /* Mention en clair d'un badge, sans balise ; '' pour un badge d'erreur */
    function badgeMention(kind, name, space) {
        let mention = '';
        if (space === 'canvas') {
            mention = kind === 'create' ? 'l\'assistant a rédigé le texte du Canvas'
                : kind === 'edit' ? 'l\'assistant a modifié le texte du Canvas' : '';
        } else {
            mention = kind === 'create' ? `l'assistant a créé ${name} dans les Artifacts`
                : kind === 'edit' ? `l'assistant a modifié ${name} dans les Artifacts`
                : kind === 'delete' ? `l'assistant a supprimé ${name} des Artifacts` : '';
        }
        return mention ? `\n\n[${mention}]\n\n` : '';
    }

    /* Badges en balises à placeholder de leur espace (imitées par les petits modèles) ; autre espace : mention */
    function markersToText(text, mode) {
        if (typeof text !== 'string') return text;
        if (mode === undefined) mode = state.mode;
        // Mentions recopiées retirées avant d'écrire les nôtres
        return stripFakeMentions(unfenceMarkers(text)).replace(INLINE_OP_RE, m => {
            const kind = /data-kind="([^"]*)"/.exec(m);
            const name = /data-name="([^"]*)"/.exec(m);
            if (!kind || !name || (kind[1] !== 'create' && kind[1] !== 'edit')) return '';
            const n = unescapeHtml(name[1]);
            const space = badgeSpace(m, n, mode);
            if (mode && space !== mode) return badgeMention(kind[1], n, space);
            if (space === 'canvas') return `\n\n<canvas-doc>\n${CANVAS_PLACEHOLDER}\n</canvas-doc>\n\n`;
            return `\n\n<artifact-file name="${n}">\n${ARTIFACTS_PLACEHOLDER}\n</artifact-file>\n\n`;
        }).replace(/\n{3,}/g, '\n\n').trim();
    }

    /* Badges en mentions en clair : pour un modèle sans balises ou un résumé, qui les imiteraient */
    function markersToPlainText(text, mode) {
        if (typeof text !== 'string') return text;
        if (mode === undefined) mode = state.mode;
        return stripFakeMentions(unfenceMarkers(text)).replace(INLINE_OP_RE, m => {
            const kind = /data-kind="([^"]*)"/.exec(m);
            const name = /data-name="([^"]*)"/.exec(m);
            if (!kind || !name) return '';
            const n = unescapeHtml(name[1]);
            return badgeMention(kind[1], n, badgeSpace(m, n, mode));
        }).replace(/\n{3,}/g, '\n\n').trim();
    }

    // ---------- Message de l'utilisateur sur un passage du Canvas ----------

    /* Passage court : la phrase où il a été sélectionné, pour que <find> ne vise pas une autre phrase */
    function focusContextLine(focus) {
        const doc = focus && focus.docName && state.mode === 'canvas' && focus.docName in state.files ? focus.docName : activeDoc();
        const src = doc ? state.files[doc] : '';
        const ex = focus.excerpt;
        const start = Number(focus.start), end = Number(focus.end);
        if (!src || ex.length > 40 || src.slice(start, end) !== ex) return '';
        let a = start, b = end;
        while (a > 0 && start - a < 160 && !/[.!?…\n]/.test(src[a - 1])) a--;
        while (b < src.length && b - end < 160 && !/[.!?…\n]/.test(src[b])) b++;
        if (b < src.length && /[.!?…]/.test(src[b])) b++;
        const sentence = src.slice(a, b).trim();
        if (!sentence || sentence === ex) return '';
        return `Ce passage est « ${ex} » dans la phrase : « ${sentence} ».\n`;
    }

    function decorateApiMessage(m, opts) {
        if (!m || typeof m !== 'object') return m;
        opts = opts || {};
        const mode = opts.mode === undefined ? state.mode : opts.mode;
        if (m.role === 'assistant' && typeof m.content === 'string' && m.content.indexOf('canvas-inline-op') >= 0) {
            // opts.plain (outils) : mentions en clair, sans balise à imiter
            const content = opts.canvasActive && !opts.plain ? markersToText(m.content, mode) : markersToPlainText(m.content, mode);
            return content === m.content ? m : { ...m, content };
        }
        const af = m.role === 'user' && m.artifactFocus;
        if (af && typeof af.label === 'string') {
            const ask = (typeof m.content === 'string' ? m.content
                : Array.isArray(m.content) ? m.content.filter(p => p && p.type === 'text').map(p => p.text).join('\n') : '').trim();
            const text = opts.isLastUser && opts.canvasActive && mode === 'artifacts'
                ? `Élément choisi par l'utilisateur dans l'aperçu de ${af.page || 'la page'} : ${af.label}${af.path ? ` (chemin : ${af.path})` : ''}.\n`
                    + `Son code dans la page affichée :\n${af.html || ''}\n`
                    + `Sa demande, pour cet élément : ${ask}`
                : `[Élément de ${af.page || 'la page'} : ${af.label}${af.text ? ` « ${String(af.text).slice(0, 80)} »` : ''}] ${ask}`;
            if (typeof m.content === 'string') return { ...m, content: text };
            const rest = Array.isArray(m.content) ? m.content.filter(p => !p || p.type !== 'text') : [];
            return { ...m, content: [{ type: 'text', text }, ...rest] };
        }
        const focus = m.role === 'user' && m.canvasFocus;
        if (!focus || typeof focus.excerpt !== 'string' || !focus.excerpt) return m;
        const instruction = (typeof m.content === 'string' ? m.content
            : Array.isArray(m.content) ? m.content.filter(p => p && p.type === 'text').map(p => p.text).join('\n') : '').trim();
        const excerpt = focus.excerpt;
        let text;
        if (!opts.isLastUser || !opts.canvasActive || mode !== 'canvas') {
            const head = excerpt.replace(/\s+/g, ' ').trim();
            text = `[Passage du Canvas : « ${head.slice(0, 40)}${head.length > 40 ? '…' : ''} »] ${instruction}`;
        } else {
            // Outils : edit_document dit comment remplacer (« find » vide) ; balises : bloc pré-rempli à recopier
            text = (excerpt.length <= 1500 ? `Passage choisi dans le texte du Canvas : «««${excerpt}»»»\n` + focusContextLine(focus) : `Passage choisi dans le texte du Canvas :\n«««\n${excerpt}\n»»»\n`) +
                `Demande de l'utilisateur : ${instruction}`;
            if (!opts.plain) {
                text += '\n\nPour modifier ce passage, et seulement lui, réponds avec ce bloc, en remplaçant « … » par le passage réécrit, puis une phrase d\'explication :\n' +
                    (excerpt.length <= 1500 ? `<canvas-doc-edit>\n<find>${excerpt}</find>\n<replace>…</replace>\n</canvas-doc-edit>` : '<canvas-doc-edit>\n<replace>…</replace>\n</canvas-doc-edit>');
            }
        }
        if (typeof m.content === 'string') return { ...m, content: text };
        const rest = Array.isArray(m.content) ? m.content.filter(p => !p || p.type !== 'text') : [];
        return { ...m, content: [{ type: 'text', text }, ...rest] };
    }

    // Code écrit dans des blocs ``` (petits modèles qui ignorent les balises)

    const FILE_NAME_RE = /[\w][\w./-]*\.(?:html?|css|js|mjs|json|md|markdown|txt|svg)\b/gi;
    const LANG_EXT = { html: 'html', htm: 'html', css: 'css', js: 'js', javascript: 'js', mjs: 'js', json: 'json', md: 'md', markdown: 'md', svg: 'svg' };

    /* before : dernière ligne de texte non vide avant le bloc */
    function fencedBlocks(text) {
        const blocks = [];
        let pos = 0, open = null, before = '';
        for (const raw of text.split('\n')) {
            const line = raw.replace(/\r$/, '');
            const m = FENCE_LINE_RE.exec(line);
            if (!open) {
                if (m && (m[2][0] !== '`' || m[3].indexOf('`') < 0)) {
                    open = { start: pos, ch: m[2][0], len: m[2].length, info: m[3].trim(), bodyStart: pos + raw.length + 1, before };
                } else if (line.trim()) before = line.trim();
            } else if (m && m[2][0] === open.ch && m[2].length >= open.len && !m[3].trim()) {
                blocks.push({ start: open.start, end: pos + raw.length, info: open.info, body: text.slice(open.bodyStart, Math.max(open.bodyStart, pos - 1)), before: open.before });
                open = null;
                before = '';
            }
            pos += raw.length + 1;
        }
        return blocks;
    }

    /* Ordre de confiance : nom dans l'en-tête, commentaire en 1re ligne, nom juste avant, puis langage */
    function fenceTarget(b, files) {
        let names = b.info.match(FILE_NAME_RE);
        if (names && names.length === 1) return { name: names[0], body: b.body };
        const lines = b.body.split('\n');
        const firstIdx = lines.findIndex(l => l.trim());
        const first = firstIdx >= 0 ? lines[firstIdx].trim() : '';
        const c = /^(?:<!--|\/\*|\/\/)\s*(?:(?:fichier|file)\s*:?\s*)?([\w][\w./-]*\.\w+)\s*(?:-->|\*\/)?$/i.exec(first);
        if (c) return { name: c[1], body: lines.slice(firstIdx + 1).join('\n') };
        if (b.before && b.before.indexOf('canvas-inline-op') < 0) {
            names = [...new Set(b.before.match(FILE_NAME_RE) || [])];
            if (names.length === 1) return { name: names[0], body: b.body };
        }
        const ext = LANG_EXT[(b.info.split(/\s+/)[0] || '').toLowerCase()];
        if (!ext) return null;
        const same = Object.keys(files).filter(n => fileExtension(n) === ext || (ext === 'html' && isHtmlFile(n)));
        if (ext === 'html') {
            if (!/<html[\s>]|<!doctype/i.test(b.body)) return null;
            const name = same.length === 1 ? same[0] : !same.length || 'index.html' in files ? 'index.html' : null;
            return name ? { name, body: b.body } : null;
        }
        if (same.length === 1) return { name: same[0], body: b.body };
        if (same.length || (ext !== 'css' && ext !== 'js')) return null;
        const pages = Object.keys(files).filter(isHtmlFile).map(n => files[n]).join('\n');
        const re = ext === 'css' ? /<link\b[^>]*\bhref=["']([^"':]+\.css)["']/gi : /<script\b[^>]*\bsrc=["']([^"':]+\.js)["']/gi;
        const refs = [...new Set([...pages.matchAll(re)].map(m => m[1].replace(/^\.\//, '')))];
        return refs.length === 1 ? { name: refs[0], body: b.body } : null;
    }

    // Mode null : seul du code crée des Artifacts (un bloc ```markdown d'une réponse n'ouvre rien)
    const CODE_TARGET_RE = /\.(?:html?|css|m?js|json|svg)$/i;

    /* Mode null : import seulement si l'utilisateur demande une création et que la réponse l'annonce */
    function importCodeBlocks(text, skipNames, opts) {
        if (typeof text !== 'string' || !/```|~~~/.test(text)) return { text, count: 0 };
        if (state.mode === 'canvas') return importDocFence(text, skipNames, opts);
        // Simple question sur le projet : ses extraits ne sont pas des fichiers ; une demande polie en est une
        const asked = String((opts && opts.userText) || '');
        if (state.mode === 'artifacts' && askKind(asked) === 'question' && !CHANGE_ASK_RE.test(asked)) return { text, count: 0 };
        if (!state.mode && !(opts && opts.announces && askKind(opts.userText) === 'create')) return { text, count: 0 };
        const badged = new Set(badgeKeys(text));
        const written = [];
        let out = '', last = 0, count = 0;
        for (const b of fencedBlocks(text)) {
            const target = fenceTarget(b, state.files);
            if (!target) continue;
            const name = target.name.replace(/^\.\//, '');
            if (!state.mode && !CODE_TARGET_RE.test(name)) continue;
            const body = target.body.replace(/\r\n/g, '\n').trim();
            if (!body || (skipNames && skipNames.indexOf(name) >= 0)) continue;
            if (isLocked(name)) continue;
            const existed = Object.prototype.hasOwnProperty.call(state.files, name);
            const content = existed ? mergeLoose(name, state.files[name], body) : body;
            if (content === null || (existed && (content === state.files[name] || LAZY_RE.test(body)))) continue;
            pushHistory();
            state.files[name] = content;
            state.aiFiles[name] = content;
            state.selectedFile = name;
            if (!state.mode) state.mode = 'artifacts';
            out += text.slice(last, b.start) + (badged.has(name) ? '' : buildInlineOpMarker(name, { kind: 'file', family: 'artifacts' }, existed));
            badged.add(name);
            written.push(name);
            last = b.end;
            count++;
        }
        if (!count) return { text, count: 0 };
        previewAfterAiTurn(written);
        state.previewDirty = true;
        if (!isPanelOpen()) showPanel();
        render();
        notifyStateChange();
        return { text: out + text.slice(last), count };
    }

    /* Un seul bloc markdown ≥ 60 % du texte réécrit le Canvas ; refusé si code ou < 40 % des mots longs gardés */
    function importDocFence(text, skipNames, opts) {
        const doc = activeDoc();
        if (!doc || !opts || !opts.announces || (skipNames && skipNames.indexOf(doc) >= 0)) return { text, count: 0 };
        const blocks = fencedBlocks(text).filter(b => DOC_FENCE_LANG_RE.test((b.info.split(/\s+/)[0] || '')));
        if (blocks.length !== 1) return { text, count: 0 };
        const b = blocks[0];
        const body = cleanDocBody(b.body.replace(/\r\n/g, '\n'));
        const src = state.files[doc];
        if (!body.trim() || body === src || body.trim().length < 0.6 * src.trim().length || LAZY_DOC_RE.test(body) || isTemplateText(body)
            || looksLikeCode(body) || vocabShare(body, src) < 0.4) {
            return { text, count: 0 };
        }
        pushHistory();
        state.files[doc] = body;
        state.aiFiles[doc] = body;
        state.selectedFile = doc;
        state.docTitles[doc] = resolveDocTitle('', body, state.docTitles[doc] || '');
        if (src.trim()) state._docFlash = { before: src, after: body };
        const marker = new Set(badgeKeys(text)).has(doc) ? '' : buildInlineOpMarker(doc, { kind: 'file', family: 'canvas' }, !!src.trim());
        state.previewDirty = true;
        if (!isPanelOpen()) showPanel();
        render();
        notifyStateChange();
        return { text: text.slice(0, b.start) + marker + text.slice(b.end), count: 1 };
    }

    // ---------- Diff (LCS ligne à ligne) ----------

    const DIFF_MAX_LINES = 3000;

    /* Retourne null si un côté dépasse DIFF_MAX_LINES (affichage en texte brut) */
    function lineDiff(oldText, newText) {
        const oldLines = (oldText == null ? '' : String(oldText)).split('\n');
        const newLines = (newText == null ? '' : String(newText)).split('\n');
        const m = oldLines.length, n = newLines.length;
        if (m > DIFF_MAX_LINES || n > DIFF_MAX_LINES) return null;
        const dp = new Array(m + 1);
        for (let i = 0; i <= m; i++) dp[i] = new Int32Array(n + 1);
        for (let i = m - 1; i >= 0; i--) {
            for (let j = n - 1; j >= 0; j--) {
                if (oldLines[i] === newLines[j]) {
                    dp[i][j] = dp[i + 1][j + 1] + 1;
                } else {
                    dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
                }
            }
        }
        const result = [];
        let i = 0, j = 0;
        while (i < m && j < n) {
            if (oldLines[i] === newLines[j]) {
                result.push({ type: 'equal', text: oldLines[i] });
                i++; j++;
            } else if (dp[i + 1][j] >= dp[i][j + 1]) {
                result.push({ type: 'removed', text: oldLines[i] });
                i++;
            } else {
                result.push({ type: 'added', text: newLines[j] });
                j++;
            }
        }
        while (i < m) result.push({ type: 'removed', text: oldLines[i++] });
        while (j < n) result.push({ type: 'added', text: newLines[j++] });
        return result;
    }

    function captureBaseline() {
        // Snapshot pris AVANT que le tour de l'IA ne modifie quoi que ce soit
        state.baseline = cloneFiles(state.files);
    }

    /* Conversation rouverte : référence = état d'avant la dernière réponse (canvasBefore), sinon rien à montrer */
    function setBaseline(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') return;
        const clone = Object.create(null);
        for (const k in snapshot) {
            if (typeof snapshot[k] === 'string') clone[k] = snapshot[k];
        }
        state.baseline = clone;
        render();
    }

    function changedSinceBaseline(name) {
        return name in state.files && state.baseline[name] !== state.files[name];
    }

    function getCurrentSnapshot() {
        return cloneFiles(state.files);
    }

    function filesEqual(a, b) {
        if (!a || !b) return a === b;
        const ka = Object.keys(a), kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        for (const k of ka) {
            if (a[k] !== b[k]) return false;
        }
        return true;
    }

    /* meta absent (anciennes conversations) : mode actuel gardé s'il reste des fichiers, sinon déduit */
    function restoreSnapshot(snapshot, meta) {
        if (!snapshot || typeof snapshot !== 'object') return false;
        endEditSession();
        pushHistory();
        const clone = Object.create(null);
        for (const k in snapshot) {
            if (typeof snapshot[k] === 'string') clone[k] = snapshot[k];
        }
        state.files = clone;
        // Comme showSnapshot : des fichiers non texte seuls restent des Artifacts
        state.mode = normalizeMode(meta && meta.mode, clone, state.mode) || (hasAssets() ? 'artifacts' : null);
        if (state.selectedFile && !(state.selectedFile in state.files)) {
            state.selectedFile = Object.keys(state.files)[0] || null;
        }
        // Titres de cet état (ceux d'un tour raté disparaissent) ; état sans infos : titres actuels gardés
        if (state.mode !== 'canvas') state.docTitles = Object.create(null);
        else if (meta) state.docTitles = titlesFrom(meta, clone, state.selectedFile);
        // Après un revert, baseline = files jusqu'au prochain tour de l'IA (aucune diff à montrer)
        state.baseline = cloneFiles(state.files);
        // Modifications à la main de ce tour déjà signalées avec son message
        state.aiFiles = cloneFiles(state.files);
        state.lastError = null;
        state.previewDirty = true;
        render();
        notifyStateChange();
        return true;
    }

    function renderPlain(content) {
        const lines = String(content).split('\n');
        const padWidth = String(lines.length).length;
        return lines.map((line, i) => {
            const num = String(i + 1).padStart(padWidth, ' ');
            return `<span class="canvas-line-num">${num}</span>${escapeHtml(line) || ' '}`;
        }).join('\n');
    }

    function renderDiff(oldContent, newContent) {
        const diff = lineDiff(oldContent || '', newContent || '');
        if (!diff) {
            return `<span class="canvas-line-num" style="opacity:0.6">Fichier trop volumineux pour calculer un diff.</span>\n` + renderPlain(newContent);
        }
        const maxLines = Math.max(
            diff.filter(e => e.type !== 'removed').length,
            diff.filter(e => e.type !== 'added').length,
            1
        );
        const padWidth = String(maxLines).length;
        let oldNum = 0, newNum = 0;
        const rows = diff.map((entry) => {
            let leftNum, marker, cls;
            if (entry.type === 'equal') {
                oldNum++; newNum++;
                leftNum = String(newNum).padStart(padWidth, ' ');
                marker = ' ';
                cls = 'equal';
            } else if (entry.type === 'added') {
                newNum++;
                leftNum = String(newNum).padStart(padWidth, ' ');
                marker = '+';
                cls = 'added';
            } else {
                oldNum++;
                leftNum = ''.padStart(padWidth, ' ');
                marker = '-';
                cls = 'removed';
            }
            const text = escapeHtml(entry.text) || ' ';
            return `<span class="canvas-diff-line ${cls}"><span class="canvas-line-num">${leftNum}</span><span class="canvas-diff-marker">${marker}</span>${text}</span>`;
        });
        // Pas de "\n" entre les <span> display:block du <pre> (ligne vide) ; .canvas-diff suit le défilement
        return '<span class="canvas-diff">' + rows.join('') + '</span>';
    }

    // Vue Code : une zone de saisie sans défilement propre recouvre les lignes numérotées

    function isDocumentFile(name) { return isMarkdownFile(name) || isTextFile(name); }

    function makeCodeLine(text) {
        const el = document.createElement('div');
        el.className = 'canvas-code-line';
        el.textContent = text;
        return el;
    }

    /* Ne touche qu'aux lignes changées (frappe dans un gros fichier) */
    function syncCodeLines(ed, text) {
        const next = text.split('\n');
        const prev = ed.lineTexts;
        const min = Math.min(prev.length, next.length);
        let start = 0;
        while (start < min && prev[start] === next[start]) start++;
        let endPrev = prev.length - 1, endNext = next.length - 1;
        while (endPrev >= start && endNext >= start && prev[endPrev] === next[endNext]) { endPrev--; endNext--; }
        const oldCount = endPrev - start + 1, newCount = endNext - start + 1;
        const common = Math.min(oldCount, newCount);
        const rows = ed.lines.children;
        for (let i = 0; i < common; i++) rows[start + i].textContent = next[start + i];
        if (newCount > common) {
            const frag = document.createDocumentFragment();
            for (let i = start + common; i <= endNext; i++) frag.appendChild(makeCodeLine(next[i]));
            ed.lines.insertBefore(frag, rows[start + common] || null);
        } else {
            for (let i = endPrev; i >= start + common; i--) rows[i].remove();
        }
        ed.lineTexts = next;
    }

    function setCodeText(ed, text) {
        if (ed.text === text) return;
        ed.text = text;
        ed.indent = null; // changé de l'extérieur : retrait à redéterminer
        syncCodeLines(ed, text);
        if (ed.input && ed.input.value !== text) ed.input.value = text;
    }

    function setCodeEditable(ed, editable) {
        if (editable && !ed.input) {
            const ta = document.createElement('textarea');
            const doc = isDocumentFile(ed.name);
            ta.className = 'canvas-code-input';
            ta.setAttribute('aria-label', 'Contenu de ' + ed.name);
            ta.setAttribute('autocapitalize', 'off');
            ta.setAttribute('autocomplete', 'off');
            ta.setAttribute('autocorrect', 'off');
            ta.spellcheck = doc;
            if (!doc) ta.setAttribute('wrap', 'off');
            ta.value = ed.text;
            ta.addEventListener('input', onEditorInput);
            ta.addEventListener('keydown', onEditorKeydown);
            ta.addEventListener('blur', endEditSession);
            ta.addEventListener('keyup', (e) => {
                if (/^(?:Arrow|Page|Home|End)/.test(e.key)) scheduleRevealCaret();
            });
            ed.root.appendChild(ta);
            ed.input = ta;
        } else if (!editable && ed.input) {
            endEditSession();
            ed.input.remove();
            ed.input = null;
        }
        ed.root.classList.toggle('is-editable', !!ed.input);
    }

    /* Même vue gardée tant que le fichier ne change pas (position, sélection et annulation conservées) */
    function showCodeView(d, name, content, editable) {
        let ed = state._editor;
        if (!ed || ed.name !== name || !ed.root.isConnected) {
            dropCodeView();
            const root = document.createElement('div');
            root.className = 'canvas-code' + (isDocumentFile(name) ? ' is-wrapped' : '');
            const lines = document.createElement('div');
            lines.className = 'canvas-code-lines';
            root.appendChild(lines);
            ed = state._editor = { name, root, lines, input: null, lineTexts: [], text: null };
            d.viewerContent.textContent = '';
            d.viewerContent.appendChild(root);
            d.viewerContent.scrollTop = 0;
            d.viewerContent.scrollLeft = 0;
        }
        setCodeText(ed, content);
        setCodeEditable(ed, editable);
    }

    function dropCodeView() {
        const ed = state._editor;
        if (!ed) return;
        if (ed.input) endEditSession();
        state._editor = null;
    }

    function onEditorInput() {
        const ed = state._editor;
        if (!ed || !ed.input) return;
        const name = ed.name;
        const value = ed.input.value;
        if (readOnlyReason(name)) {
            // Ne devrait pas arriver (zone de saisie retirée avant) : contenu enregistré remis
            ed.input.value = ed.text;
            return;
        }
        if (value !== state.files[name]) {
            // Première frappe de la séance : l'état d'avant devient une version
            if (state.editSession !== name) {
                endEditSession();
                pushHistory();
                state.editSession = name;
                renderHistoryUi(dom());
            }
            state.files[name] = value;
            state.previewDirty = true;
            schedulePersist();
            scheduleLiveStats();
        }
        ed.text = value;
        syncCodeLines(ed, value);
        // Garde-fou : la zone de saisie ne doit jamais défiler (texte décalé des numéros)
        ed.input.scrollTop = 0;
        ed.input.scrollLeft = 0;
        scheduleRevealCaret();
    }

    /* La vue suit le curseur : Chrome le fait seul à la frappe, pas tous les navigateurs ni déplacements */
    function revealCaret() {
        const ed = state._editor;
        const sc = dom().viewerContent;
        if (!ed || !ed.input || !sc || document.activeElement !== ed.input) return;
        const ta = ed.input;
        const pos = ta.selectionDirection === 'backward' ? ta.selectionStart : ta.selectionEnd;
        const value = ta.value;
        let line = 0, lineStart = 0;
        for (let i = value.indexOf('\n'); i >= 0 && i < pos; i = value.indexOf('\n', i + 1)) {
            line++;
            lineStart = i + 1;
        }
        const row = ed.lines.children[line];
        if (!row) return;
        let rect = null;
        const text = row.firstChild;
        if (text && text.nodeType === 3) {
            const range = document.createRange();
            const offset = Math.min(pos - lineStart, text.length);
            range.setStart(text, offset);
            range.setEnd(text, offset);
            rect = range.getClientRects()[0] || null;
        }
        if (!rect) rect = row.getBoundingClientRect();
        const box = sc.getBoundingClientRect();
        const lineHeight = parseFloat(getComputedStyle(row).lineHeight) || 20;
        const margin = 8;
        if (rect.top < box.top + margin) sc.scrollTop -= box.top + margin - rect.top;
        else if (rect.top + lineHeight > box.bottom - margin) sc.scrollTop += rect.top + lineHeight - (box.bottom - margin);
        if (rect.left > box.right - 2 * margin) sc.scrollLeft += rect.left - (box.right - 2 * margin) + 40;
        else if (rect.left < box.left + margin && sc.scrollLeft > 0) sc.scrollLeft -= box.left + margin - rect.left + 40;
    }

    function scheduleRevealCaret() {
        if (state._revealFrame) return;
        state._revealFrame = requestAnimationFrame(() => {
            state._revealFrame = 0;
            revealCaret();
        });
    }

    /* Garde l'annulation native de la zone de saisie (Cmd/Ctrl+Z) */
    function insertText(ta, text) {
        if (!document.execCommand('insertText', false, text)) {
            ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
            ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    /* Tabulation si utilisée, sinon l'écart de retrait le plus fréquent, ou null */
    function detectIndent(text) {
        const steps = new Map();
        let tabs = 0, spaced = 0, prev = 0, seen = 0;
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            if (++seen > 2000) break;
            const lead = /^[ \t]*/.exec(line)[0];
            if (lead.includes('\t')) { tabs++; continue; }
            if (lead.length) spaced++;
            const step = Math.abs(lead.length - prev);
            prev = lead.length;
            if (step >= 2 && step <= 8) steps.set(step, (steps.get(step) || 0) + 1);
        }
        if (tabs && tabs >= spaced) return '\t';
        let best = 0, bestCount = 0;
        for (const [step, count] of steps) {
            if (count > bestCount || (count === bestCount && step < best)) { best = step; bestCount = count; }
        }
        return best ? ' '.repeat(best) : null;
    }

    /* Fixé à la première tabulation (une sélection indentée ne change pas l'unité), 4 espaces par défaut */
    function indentUnit(ed) {
        if (!ed.indent) ed.indent = detectIndent(ed.input.value);
        return ed.indent || '    ';
    }

    function indentSelection(ed, outdent) {
        const ta = ed.input;
        const value = ta.value;
        const unit = indentUnit(ed);
        const start = ta.selectionStart;
        let end = ta.selectionEnd;
        const multi = value.slice(start, end).includes('\n');
        if (!multi && !outdent) { insertText(ta, unit); return; }
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        // Une sélection qui s'arrête en début de ligne n'inclut pas cette ligne
        if (multi && value[end - 1] === '\n') end--;
        let lineEnd = value.indexOf('\n', end);
        if (lineEnd < 0) lineEnd = value.length;
        const block = value.slice(lineStart, lineEnd);
        const lead = new RegExp('^(?:\\t| {1,' + (unit === '\t' ? 4 : unit.length) + '})');
        let firstDelta = 0;
        const out = block.split('\n').map((line, i) => {
            let next;
            if (outdent) {
                const m = lead.exec(line);
                next = m ? line.slice(m[0].length) : line;
            } else {
                next = line.trim() ? unit + line : line;
            }
            if (i === 0) firstDelta = next.length - line.length;
            return next;
        }).join('\n');
        if (out === block) return;
        ta.setSelectionRange(lineStart, lineEnd);
        insertText(ta, out);
        if (multi) {
            ta.setSelectionRange(lineStart, lineStart + out.length);
        } else {
            const pos = Math.max(lineStart, start + firstDelta);
            ta.setSelectionRange(pos, pos);
        }
    }

    function onEditorKeydown(e) {
        const ta = e.currentTarget;
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            endEditSession();
            ta.blur();
            return;
        }
        const mod = e.metaKey || e.ctrlKey;
        if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
            // Cmd/Ctrl+S enregistre aussitôt au lieu d'ouvrir l'enregistrement de page du navigateur
            e.preventDefault();
            flushPersist();
            return;
        }
        if (e.key === 'Tab' && !mod && !e.altKey && state._editor && state._editor.input === ta) {
            e.preventDefault();
            indentSelection(state._editor, e.shiftKey);
            return;
        }
        if (e.key === 'Enter' && !e.shiftKey && !mod && !e.altKey) {
            const start = ta.selectionStart;
            const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
            const indent = /^[ \t]*/.exec(ta.value.slice(lineStart, start))[0];
            if (indent) {
                e.preventDefault();
                insertText(ta, '\n' + indent);
            }
        }
    }

    /* Bulle du nom : nom et taille (le total est dans le pied de page) */
    function fileTooltip(name, content) {
        return name + ' · ' + formatSize(byteSize(content)) + (isLocked(name) ? '\nVerrouillé\u00a0: l\'IA ne peut pas le modifier' : '');
    }

    function scheduleLiveStats() {
        if (state._statsFrame) return;
        state._statsFrame = requestAnimationFrame(() => {
            state._statsFrame = 0;
            const d = dom();
            renderStatus(d);
            const ed = state._editor;
            if (!ed || !d.fileList || !(ed.name in state.files)) return;
            for (const item of d.fileList.children) {
                if (item.dataset.name !== ed.name) continue;
                const nameEl = item.querySelector('.canvas-file-name');
                if (nameEl) nameEl.title = fileTooltip(ed.name, state.files[ed.name]);
                break;
            }
        });
    }

    // ---------- Rendu UI ----------

    function dom() {
        if (state._dom) return state._dom;
        state._dom = {
            panel: document.getElementById('canvas-panel'),
            resizeHandle: document.getElementById('canvas-resize-handle'),
            fileList: document.getElementById('canvas-file-list'),
            btnNew: document.getElementById('canvas-new-btn'),
            btnImport: document.getElementById('canvas-import-btn'),
            importInput: document.getElementById('canvas-import-input'),
            importDirInput: document.getElementById('canvas-import-dir-input'),
            importZipInput: document.getElementById('canvas-import-zip-input'),
            importMenu: document.getElementById('canvas-import-menu'),
            dropOverlay: document.getElementById('canvas-drop-overlay'),
            viewer: document.getElementById('canvas-viewer'),
            readOnlyHint: document.getElementById('canvas-viewer-readonly'),
            viewerContent: document.getElementById('canvas-viewer-content'),
            diffCheckbox: document.getElementById('canvas-diff-checkbox'),
            emptyState: document.getElementById('canvas-empty'),
            statusEl: document.getElementById('canvas-status'),
            btnToggle: document.getElementById('canvas-toggle-btn'),
            btnClose: document.getElementById('canvas-close-btn'),
            btnFullscreen: document.getElementById('canvas-fullscreen-btn'),
            btnRefresh: document.getElementById('canvas-refresh-btn'),
            btnDownload: document.getElementById('canvas-download-btn'),
            btnHistory: document.getElementById('canvas-history-btn'),
            historyBar: document.getElementById('canvas-history-bar'),
            historyUndo: document.getElementById('canvas-history-undo'),
            historyRedo: document.getElementById('canvas-history-redo'),
            historyPos: document.getElementById('canvas-history-position'),
            historyApply: document.getElementById('canvas-history-apply'),
            historyClose: document.getElementById('canvas-history-close'),
            btnClear: document.getElementById('canvas-clear-btn'),
            headerTitle: document.querySelector('#canvas-panel .canvas-header-title span'),
            tabCode: document.getElementById('canvas-tab-code'),
            tabPreview: document.getElementById('canvas-tab-preview'),
            viewCode: document.getElementById('canvas-code-view'),
            viewPreview: document.getElementById('canvas-preview-view'),
            previewIframe: document.getElementById('canvas-preview-iframe'),
            btnPick: document.getElementById('canvas-pick-btn'),
            pickMenu: document.getElementById('canvas-pick-menu'),
            pickLabel: document.getElementById('canvas-pick-label'),
            pickText: document.getElementById('canvas-pick-text'),
            pickActions: document.getElementById('canvas-pick-actions'),
            pickAskBtn: document.getElementById('canvas-pick-ask'),
            pickEditBtn: document.getElementById('canvas-pick-edit'),
            pickForm: document.getElementById('canvas-pick-form'),
            pickInput: document.getElementById('canvas-pick-input'),
            editBanner: document.getElementById('canvas-edit-banner'),
            editBannerText: document.getElementById('canvas-edit-banner-text'),
            editDone: document.getElementById('canvas-edit-done'),
            previewEmpty: document.getElementById('canvas-preview-empty'),
            previewBar: document.getElementById('canvas-preview-bar'),
            previewFileBtn: document.getElementById('canvas-preview-file'),
            codeView: document.getElementById('canvas-code-view'),
            codeFileBtn: document.getElementById('canvas-code-file'),
            codeFileName: document.getElementById('canvas-code-file-name'),
            codeFileIcon: document.getElementById('canvas-code-file-icon'),
            sidebar: document.getElementById('canvas-sidebar'),
            previewFileIcon: document.getElementById('canvas-preview-file-icon'),
            previewFileName: document.getElementById('canvas-preview-file-name'),
            previewMenu: document.getElementById('canvas-preview-menu'),
            previewLoading: document.getElementById('canvas-preview-loading'),
            consoleBtn: document.getElementById('canvas-console-btn'),
            consoleCount: document.getElementById('canvas-console-count'),
            console: document.getElementById('canvas-console'),
            consolePage: document.getElementById('canvas-console-page'),
            consoleList: document.getElementById('canvas-console-list'),
            consoleSend: document.getElementById('canvas-console-send'),
            consoleClear: document.getElementById('canvas-console-clear'),
            consoleClose: document.getElementById('canvas-console-close'),
            viewDoc: document.getElementById('canvas-doc-view'),
            docTabs: document.getElementById('canvas-doc-tabs'),
            docTabsPrev: document.getElementById('canvas-doc-tabs-prev'),
            docTabsNext: document.getElementById('canvas-doc-tabs-next'),
            docAddMenu: document.getElementById('canvas-doc-add-menu'),
            diffCode: document.getElementById('canvas-diff-code'),
            diffDoc: document.getElementById('canvas-diff-doc'),
            downloadAll: document.getElementById('canvas-download-all'),
            docScroll: document.getElementById('canvas-doc-scroll'),
            docPage: document.getElementById('canvas-doc-page'),
            docState: document.getElementById('canvas-doc-state'),
            docReadOnly: document.getElementById('canvas-doc-readonly'),
            docDiffCheckbox: document.getElementById('canvas-doc-diff-checkbox'),
            docTitle: document.getElementById('canvas-doc-title'),
            docTip: document.getElementById('canvas-doc-tip'),
            btnCopy: document.getElementById('canvas-copy-btn'),
            downloadMenu: document.getElementById('canvas-download-menu'),
            codeEmpty: document.getElementById('canvas-code-empty'),
            emptyNewDoc: document.getElementById('canvas-empty-new-doc'),
            emptyNewFile: document.getElementById('canvas-empty-new-file'),
            emptyImport: document.getElementById('canvas-empty-import'),
            btnImportDoc: document.getElementById('canvas-import-doc-btn'),
            emptyImportDoc: document.getElementById('canvas-empty-import-doc'),
            docImportInput: document.getElementById('canvas-doc-import-input')
        };
        return state._dom;
    }

    function sortFileNames(names) {
        return names.sort((a, b) => {
            if (a === state.entrypoint) return -1;
            if (b === state.entrypoint) return 1;
            return a.localeCompare(b);
        });
    }

    const LOCK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
    const LOCK_OPEN_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';
    const LOCKED_TIP = 'Verrouillé\u00a0: l\'IA ne peut pas modifier ce fichier';

    /* `lock` : null (fichier que l'IA ne lit pas), 'open' ou 'locked' ; `manage` false pendant une réponse (téléchargement seul) */
    function fileToolsHtml(lock, manage) {
        let html = '<span class="canvas-file-tools' + (lock === 'locked' ? ' has-lock' : '') + '">' + FILE_DOWNLOAD_BUTTON + (manage ? FILE_TOOL_BUTTONS : '');
        if (lock === 'open' && manage) html += '<button type="button" class="canvas-file-tool" data-action="lock" title="Verrouiller\u00a0: l\'IA ne pourra plus modifier ce fichier" aria-label="Verrouiller">' + LOCK_OPEN_SVG + '</button>';
        if (lock === 'locked') {
            html += manage
                ? '<button type="button" class="canvas-file-tool canvas-file-lock" data-action="lock" title="' + LOCKED_TIP + '. Cliquer pour le déverrouiller" aria-label="Déverrouiller">' + LOCK_SVG + '</button>'
                : '<span class="canvas-file-tool canvas-file-lock" title="' + LOCKED_TIP + '">' + LOCK_SVG + '</span>';
        }
        return html + '</span>';
    }

    const FILE_DOWNLOAD_BUTTON =
        '<button type="button" class="canvas-file-tool" data-action="download" title="Télécharger ce fichier" aria-label="Télécharger ce fichier">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
        '</button>';

    const FILE_TOOL_BUTTONS =
        '<button type="button" class="canvas-file-tool" data-action="rename" title="Renommer" aria-label="Renommer">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>' +
        '</button>' +
        '<button type="button" class="canvas-file-tool canvas-file-tool-danger" data-action="delete" title="Supprimer" aria-label="Supprimer">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>' +
        '</button>';

    /* Volet étroit : sélecteur du fichier affiché ; la liste s'ouvre par-dessus le code (CSS) */
    function renderCodeFileBar(d) {
        if (!d.codeFileBtn || !d.codeView) return;
        const name = state.selectedFile && (state.selectedFile in state.files || isAsset(state.selectedFile)) ? state.selectedFile : '';
        if (d.codeFileName.textContent !== (name || 'Choisir un fichier')) d.codeFileName.textContent = name || 'Choisir un fichier';
        const icon = name ? iconForFile(name) : '';
        if (d.codeFileIcon.innerHTML !== icon) d.codeFileIcon.innerHTML = icon;
        const open = d.codeView.classList.contains('is-files-open');
        d.codeFileBtn.classList.toggle('is-active', open);
        d.codeFileBtn.setAttribute('aria-expanded', String(open));
    }

    function setCodeFilesOpen(open) {
        const d = dom();
        if (!d.codeView || d.codeView.classList.contains('is-files-open') === !!open) return;
        d.codeView.classList.toggle('is-files-open', !!open);
        renderCodeFileBar(d);
    }

    // Liste en menu seulement si la barre est visible (volet étroit)
    const codeFilesMenuShown = () => { const d = dom(); return !!(d.codeView && d.codeView.classList.contains('is-files-open') && d.codeFileBtn && d.codeFileBtn.offsetParent); };

    /* Avec un fichier fantôme en cours de création (state.streamingFile, pas encore dans state.files) */
    function renderFileList(d) {
        if (!d.fileList) return;
        // Nom en cours de saisie : liste non reconstruite (le champ perdrait le focus et la saisie)
        if (state.naming && state._namingRow && state._namingRow.isConnected) return;
        const streaming = state.streamingFile;
        const displayNames = new Set(allFileNames());
        if (streaming && streaming.name) displayNames.add(streaming.name);
        const manage = canManageFiles();
        const naming = state.naming;
        const rows = sortFileNames(Array.from(displayNames)).map(name => {
            const isStreaming = !!(streaming && streaming.name === name);
            const asset = !(name in state.files) && isAsset(name);
            const exists = name in state.files || asset;
            const locked = isLocked(name);
            let cls = 'canvas-file-item' + (asset ? ' is-asset' : '') + (locked ? ' is-locked' : '');
            if (name === state.selectedFile) cls += ' selected';
            if (name === state.entrypoint) cls += ' entrypoint';
            if (isStreaming) cls += ' streaming';
            else if (state.showDiff && changedSinceBaseline(name)) cls += ' is-changed';
            if (naming && naming.mode === 'rename' && naming.name === name) return { name, cls: cls + ' is-naming', renaming: true };
            let content = '';
            if (name in state.files) content = state.files[name];
            else if (isStreaming && typeof streaming.partial === 'string') content = streaming.partial;
            const html = `
                    <span class="canvas-file-icon">${iconForFile(name)}</span>
                    <span class="canvas-file-name">${escapeHtml(name)}</span>
                    ${exists && !isStreaming ? fileToolsHtml(asset ? null : locked ? 'locked' : 'open', manage) : ''}
                `;
            return { name, cls, html, title: asset ? assetTooltip(name) : fileTooltip(name, content) };
        });
        // Lignes inchangées gardées : recréées à chaque morceau, le clic de souris était perdu
        const sig = naming ? null : rows.map(r => r.cls + '\u0001' + r.html).join('\u0002');
        if (sig !== null && sig === d.fileList._davidtwentyaiSig && d.fileList.children.length === rows.length) {
            rows.forEach((r, i) => {
                const label = d.fileList.children[i].querySelector('.canvas-file-name');
                if (label && label.title !== r.title) label.title = r.title;
            });
            return;
        }
        d.fileList._davidtwentyaiSig = sig;
        d.fileList.textContent = '';
        state._namingRow = null;
        // Lignes recréées pendant l'écriture : les animations reprennent là où elles en étaient
        const now = performance.now();
        d.fileList.style.setProperty('--stream-shimmer-delay', -(now % 1400) + 'ms');
        d.fileList.style.setProperty('--stream-pulse-delay', -(now % 1000) + 'ms');
        for (const r of rows) {
            const item = document.createElement('div');
            item.className = r.cls;
            item.dataset.name = r.name;
            if (r.renaming) {
                item.innerHTML = `<span class="canvas-file-icon">${iconForFile(r.name)}</span>`;
                item.appendChild(buildNameInput(r.name));
                state._namingRow = item;
            } else {
                item.innerHTML = r.html;
                item.querySelector('.canvas-file-name').title = r.title;
            }
            d.fileList.appendChild(item);
        }
        if (naming && naming.mode === 'new') {
            const row = document.createElement('div');
            row.className = 'canvas-file-item is-naming';
            row.innerHTML = `<span class="canvas-file-icon">${iconForFile('')}</span>`;
            row.appendChild(buildNameInput(''));
            d.fileList.appendChild(row);
            state._namingRow = row;
        }
        if (state._namingRow) {
            const err = document.createElement('div');
            err.className = 'canvas-name-error';
            err.hidden = true;
            state._namingRow.after(err);
        }
    }

    function renderViewer(d, hasAny) {
        const streaming = state.streamingFile;
        const selName = state.selectedFile;
        const isSelStreaming = !!(streaming && streaming.name === selName);
        const selExists = !!selName && selName in state.files;
        if (state.editSession && state.editSession !== selName) endEditSession();
        if (d.viewerContent && !(selName && !selExists && isAsset(selName))) delete d.viewerContent.dataset.asset;
        if (hasAny && selName && !selExists && !isSelStreaming && isAsset(selName)) {
            dropCodeView();
            if (d.viewerContent) renderAssetView(d.viewerContent, selName);
            renderReadOnlyHint(d);
            return;
        }
        if (!hasAny || !selName || !(selExists || isSelStreaming)) {
            dropCodeView();
            if (d.viewerContent) d.viewerContent.textContent = '';
            renderReadOnlyHint(d);
            return;
        }
        if (d.viewerContent) {
            if (isSelStreaming && streaming.kind === 'file' && (typeof streaming.partial === 'string' || !selExists)) {
                showCodeView(d, selName, streaming.partial || '', false);
            } else if (selExists) {
                const content = state.files[selName];
                const oldContent = state.baseline[selName];
                if (state.showDiff && oldContent !== content) {
                    dropCodeView();
                    d.viewerContent.innerHTML = renderDiff(oldContent, content);
                } else {
                    showCodeView(d, selName, content, !readOnlyReason(selName));
                }
            }
            if (isSelStreaming) d.viewerContent.scrollTop = d.viewerContent.scrollHeight;
        }
        renderReadOnlyHint(d);
    }

    function renderAssetView(el, name) {
        const a = state.assets[name];
        if (!a) { el.textContent = ''; return; }
        const kind = assetKindLabel(name, a.type);
        const key = name + '|' + a.hash;
        if (el.dataset.asset === key) return;
        el.dataset.asset = key;
        el.innerHTML = `<div class="canvas-asset-view">
            <div class="canvas-asset-media">${iconForFile(name)}</div>
            <div class="canvas-asset-name">${escapeHtml(name)}</div>
            <div class="canvas-asset-meta">${escapeHtml(kind.charAt(0).toUpperCase() + kind.slice(1))} · ${escapeHtml(formatSize(a.size))}</div>
            <p class="canvas-asset-note">L'IA ne peut ni lire ni modifier ce fichier (${escapeHtml(ASSET_WHY[a.why] || ASSET_WHY.binary)}) : elle sait seulement qu'il existe. Il sert à l'aperçu et au téléchargement.</p>
        </div>`;
        if (kind !== 'image') return;
        assetObjectUrl(a.hash).then(url => {
            if (!url || el.dataset.asset !== key) return;
            const media = el.querySelector('.canvas-asset-media');
            if (!media) return;
            const img = document.createElement('img');
            img.alt = name;
            img.src = url;
            media.textContent = '';
            media.classList.add('has-image');
            media.appendChild(img);
        });
    }

    const READ_ONLY_TIPS = {
        busy: 'Modifiable quand l\'IA aura fini de répondre',
        locked: 'Aperçu depuis le gestionnaire de stockage\u00a0: rien n\'y est modifiable',
        history: 'Appliquez cette version pour la modifier',
        diff: 'Décochez «\u00a0Afficher les modifications\u00a0» pour modifier le fichier',
        docDiff: 'Décochez «\u00a0Afficher les modifications\u00a0» pour modifier le texte',
        unchanged: 'Ce fichier n\'a pas changé depuis l\'état d\'avant la dernière réponse de l\'IA. Décochez «\u00a0Afficher les modifications\u00a0» pour le modifier',
        docUnchanged: 'Le texte n\'a pas changé depuis l\'état d\'avant la dernière réponse de l\'IA. Décochez «\u00a0Afficher les modifications\u00a0» pour le modifier',
        render: 'Mise en forme indisponible (DOMPurify n\'a pas pu être chargé)\u00a0: le texte reste en lecture seule'
    };

    function shownFile() {
        return state.mode === 'canvas' ? activeDoc() : state.selectedFile;
    }

    function docReadOnlyReason(name) {
        const why = readOnlyReason(name);
        if (why === 'diff') return 'docDiff';
        if (!why && window.CanvasDoc && !window.CanvasDoc.canRender()) return 'render';
        return why;
    }

    /* « lecture seule » toujours en mode choisi ; pendant une réponse, seulement si l'on essaie de modifier */
    function renderReadOnlyHint(d) {
        const doc = activeDoc();
        for (const [el, name, reason] of [[d.readOnlyHint, state.selectedFile, readOnlyReason], [d.docReadOnly, doc, docReadOnlyReason]]) {
            if (!el) continue;
            const streamingThis = !!(state.streamingFile && state.streamingFile.name === name);
            const why = name && name in state.files && !streamingThis ? reason(name) : null;
            const show = !!why && (why !== 'busy' || state._busyHintUntil > Date.now());
            const unchanged = (why === 'diff' || why === 'docDiff') && !changedSinceBaseline(name);
            el.hidden = !show;
            el.textContent = unchanged ? 'aucune modification' : 'lecture seule';
            el.title = show ? READ_ONLY_TIPS[unchanged ? (why === 'diff' ? 'unchanged' : 'docUnchanged') : why] : '';
        }
    }

    const DIFF_HINTS = {
        diff: 'Désactivez l\'affichage des modifications ci-dessous pour modifier le code manuellement.',
        docDiff: 'Désactivez l\'affichage des modifications ci-dessous pour modifier le texte vous-même.'
    };

    function showDiffHint(kind) {
        const d = dom();
        const box = kind === 'docDiff' ? d.diffDoc : d.diffCode;
        const input = box && !box.hidden && box.querySelector('input');
        if (!d.panel || !input) return;
        let hint = state._diffHint;
        if (!hint) {
            hint = state._diffHint = document.createElement('div');
            hint.className = 'canvas-diff-hint';
            hint.setAttribute('role', 'status');
            d.panel.appendChild(hint);
        }
        hint.textContent = DIFF_HINTS[kind];
        hint.hidden = false;
        const p = d.panel.getBoundingClientRect(), r = input.getBoundingClientRect();
        const x = r.left + r.width / 2 - p.left;
        const left = Math.max(8, Math.min(x - hint.offsetWidth / 2, p.width - hint.offsetWidth - 8));
        hint.style.left = left + 'px';
        hint.style.bottom = (p.bottom - r.top + 10) + 'px';
        hint.style.setProperty('--tail-x', (x - left) + 'px');
        hint.classList.remove('is-shown');
        void hint.offsetWidth;
        hint.classList.add('is-shown');
        clearTimeout(state._diffHintTimer);
        state._diffHintTimer = setTimeout(hideDiffHint, 4000);
    }

    function hideDiffHint() {
        clearTimeout(state._diffHintTimer);
        if (state._diffHint) state._diffHint.hidden = true;
    }

    function nudgeReadOnlyHint() {
        const d = dom();
        const name = shownFile();
        if (!name || !(name in state.files) || !readOnlyReason(name)) return;
        if (state.streamingFile && state.streamingFile.name === name) return;
        if (readOnlyReason(name) === 'diff') showDiffHint(displayMode() === 'canvas' ? 'docDiff' : 'diff');
        state._busyHintUntil = Date.now() + 4000;
        clearTimeout(state._busyHintTimer);
        state._busyHintTimer = setTimeout(() => renderReadOnlyHint(dom()), 4100);
        renderReadOnlyHint(d);
        for (const el of [d.readOnlyHint, d.docReadOnly]) {
            if (!el || el.hidden) continue;
            el.classList.remove('is-nudged');
            void el.offsetWidth;
            el.classList.add('is-nudged');
        }
    }

    function renderStatus(d) {
        if (!d.statusEl) return;
        const flash = state._statusFlash;
        const names = allFileNames();
        let text = '', title = '', error = false;
        if (flash) {
            text = flash.text;
            title = flash.title || flash.text;
            error = !!flash.error;
        } else if (state.lastError) {
            text = '⚠ ' + state.lastError;
            title = state.lastError;
            error = true;
        } else if (state.aiWriting && state.mode === 'artifacts' && state.activeTab === 'preview') {
            text = `L'IA modifie ${state.aiWriting}…`;
            title = 'L\'aperçu sera actualisé quand elle aura fini';
        } else if (activeDoc() && window.CanvasDoc) {
            const c = window.CanvasDoc.countWords(state.files[activeDoc()]);
            const n = k => k.toLocaleString('fr-FR');
            text = `${n(c.words)} ${c.words > 1 ? 'mots' : 'mot'} · ${n(c.chars)} ${c.chars > 1 ? 'caractères' : 'caractère'} · ≈ ${roundTokens(canvasTokens())} tokens`;
            title = 'Estimation\u00a0: tout le texte du Canvas est envoyé à l\'IA à chaque message';
        } else if (names.length) {
            const total = projectBytes();
            const unread = names.length - Object.keys(state.files).length;
            text = `${plural(names.length, 'fichier', 'fichiers')} · ${formatSize(total)} · ≈ ${roundTokens(canvasTokens())} tokens`;
            title = state.mode === 'canvas'
                ? 'Estimation\u00a0: tout le texte du Canvas est envoyé à l\'IA à chaque message'
                : isIndexMode()
                    ? 'Gros projet\u00a0: l\'IA reçoit à chaque message la liste des fichiers avec leur plan, et lit ceux dont elle a besoin (estimation de ce qu\'elle reçoit)'
                    : 'Estimation\u00a0: tous les fichiers des Artifacts sont envoyés à l\'IA à chaque message';
            if (unread) title += `\n${plural(unread, 'fichier grisé', 'fichiers grisés')}, que l'IA ne lit pas\u00a0: elle sait seulement qu'ils existent.`;
        }
        d.statusEl.textContent = text;
        d.statusEl.title = title;
        d.statusEl.className = 'canvas-status' + (error ? ' error' : '');
    }

    function flashStatus(text, title, error) {
        state._statusFlash = { text, title, error };
        clearTimeout(state._statusFlashTimer);
        state._statusFlashTimer = setTimeout(() => {
            state._statusFlash = null;
            renderStatus(dom());
        }, 8000);
        renderStatus(dom());
    }

    /* Disponibles dès qu'il existe une autre version, y compris plus récente après restauration */
    function renderHistoryUi(d) {
        const nav = state.historyNav;
        if (d.btnHistory) {
            d.btnHistory.disabled = state.locked || (!nav && (state.busy || versionTimeline().length < 2));
            d.btnHistory.classList.toggle('is-active', !!nav);
            d.btnHistory.title = nav ? 'Masquer l\'historique des versions' : 'Historique des versions';
        }
        if (d.historyBar) {
            d.historyBar.hidden = !nav;
            if (nav) {
                const v = nav.list[nav.index];
                const last = nav.index === nav.list.length - 1;
                d.historyPos.textContent = `Version ${nav.index + 1} sur ${nav.list.length}` + (v && v.label ? ' · ' + v.label : '') + (nav.index === nav.list.current ? ' · actuelle' : '');
                d.historyUndo.disabled = nav.index <= 0;
                d.historyRedo.disabled = last;
            }
        }
    }

    function renderFileActions(d) {
        const manage = canManageFiles();
        const why = manageBlockedReason();
        if (d.btnNew) {
            d.btnNew.disabled = !manage;
            d.btnNew.title = why || 'Créer un fichier';
        }
        if (d.btnImport) {
            d.btnImport.disabled = !manage;
            d.btnImport.title = why || 'Importer des fichiers, un dossier ou un ZIP (vous pouvez aussi les glisser sur les Artifacts)';
            if (!manage) setImportMenu(false);
        }
        if (d.btnClear) {
            d.btnClear.disabled = !manage || allFileNames().length === 0;
            d.btnClear.title = why && allFileNames().length ? why
                : state.mode === 'canvas' ? 'Vider le Canvas' : 'Vider les Artifacts';
        }
    }

    /* Celui de la conversation, celui que l'IA crée (mode encore null), ou Artifacts pour nommer un 1er fichier */
    function displayMode() {
        if (state.mode) return state.mode;
        if (state.streamingFile && state.streamingFile.family) return state.streamingFile.family;
        return state.naming && state.naming.mode === 'new' ? 'artifacts' : null;
    }

    const SPACE_TITLES = { artifacts: 'Artifacts', canvas: 'Canvas', '': 'Plan de travail' };

    function shownDocTitle() {
        const s = state.streamingFile;
        if (s && s.family === 'canvas' && s.name && !(s.name in state.files) && state.selectedFile === s.name) return resolveDocTitle(s.title, s.partial || '', '') || 'Nouveau document';
        const doc = activeDoc();
        if (doc) return docTitleIn(state.files, state.docTitles, doc);
        return s && s.family === 'canvas' ? resolveDocTitle(s.title, s.partial || '', '') : '';
    }

    function renderHeader(d, space) {
        if (d.headerTitle) d.headerTitle.textContent = SPACE_TITLES[space];
        if (d.docTitle && !state._renamingDoc) {
            const t = space === 'canvas' ? shownDocTitle() : '';
            d.docTitle.textContent = t || 'Sans titre';
            d.docTitle.classList.toggle('is-untitled', !t);
            d.docTitle.disabled = !canManageFiles() || !activeDoc();
            d.docTitle.title = d.docTitle.disabled ? (t || 'Sans titre') : (t ? t + ' · ' : '') + 'Cliquer pour renommer le texte';
        }
        if (d.btnHistory) d.btnHistory.hidden = space === '';
        if (d.btnDownload) {
            d.btnDownload.hidden = space === '';
            d.btnDownload.title = space === 'canvas' ? 'Télécharger le texte' : 'Télécharger en ZIP';
            d.btnDownload.setAttribute('aria-haspopup', space === 'canvas' ? 'menu' : 'false');
        }
        if (d.btnClear) d.btnClear.hidden = space === '';
        if (d.btnCopy) {
            d.btnCopy.hidden = space !== 'canvas' || !(activeDoc() && state.files[activeDoc()].trim());
        }
        if (d.btnImportDoc) {
            d.btnImportDoc.hidden = space !== 'canvas';
            d.btnImportDoc.disabled = !canManageFiles() || state.mode !== 'canvas';
            d.btnImportDoc.title = manageBlockedReason() || `Importer un document\u00a0: ${DOC_FORMATS_TEXT} (vous pouvez aussi le glisser ici)`;
        }
        if (space !== 'canvas') { setDownloadMenu(false); setDocAddMenu(false); }
    }

    function render() {
        const d = dom();
        if (!d.panel) return;

        // Infobulle posée par app.js (updateCanvasBtn)
        if (d.btnToggle) {
            d.btnToggle.classList.toggle('active', state.active);
            d.btnToggle.setAttribute('aria-pressed', String(!!state.active));
        }

        const space = displayMode() || '';
        if (d.panel.dataset.mode !== space) d.panel.dataset.mode = space;
        d.panel.setAttribute('aria-label', SPACE_TITLES[space]);
        renderHeader(d, space);

        renderFileList(d);
        renderFileActions(d);
        renderCodeFileBar(d);

        const streaming = state.streamingFile;
        const hasAny = Object.keys(state.files).length > 0 || hasAssets() || !!(streaming && streaming.name);
        if (d.emptyState) d.emptyState.style.display = space === '' ? '' : 'none';
        renderEmptyState(d);
        if (d.viewer) d.viewer.style.display = hasAny ? '' : 'none';
        if (d.codeEmpty) d.codeEmpty.hidden = hasAny;
        if (space === 'canvas') {
            dropCodeView();
            if (d.viewerContent && d.viewerContent.firstChild) d.viewerContent.textContent = '';
            renderDocTabs(d);
            renderDocView(d);
        } else {
            renderViewer(d, hasAny);
            if (state._doc && state._doc.mode === 'edit' && state._doc.editable) state._doc.setEditable(false);
        }

        if (d.diffCheckbox) d.diffCheckbox.checked = !!state.showDiff;
        if (d.docDiffCheckbox) d.docDiffCheckbox.checked = !!state.showDiff;
        if (d.diffCode) d.diffCode.hidden = !(space === 'artifacts' && state.activeTab === 'code' && hasAny);
        if (d.diffDoc) d.diffDoc.hidden = !(space === 'canvas' && !!activeDoc());
        if (d.docTip && space !== 'canvas') d.docTip.hidden = true;

        renderStatus(d);
        renderConsole(d);
        renderHistoryUi(d);
        if (d.btnDownload) d.btnDownload.disabled = !hasAny || (space === 'canvas' && !(state.mode === 'canvas'));

        const artifacts = space === 'artifacts';
        if (d.tabCode) d.tabCode.classList.toggle('active', state.activeTab === 'code');
        if (d.tabPreview) d.tabPreview.classList.toggle('active', state.activeTab === 'preview');
        if (d.viewCode) d.viewCode.classList.toggle('active', artifacts && state.activeTab === 'code');
        if (d.viewPreview) d.viewPreview.classList.toggle('active', artifacts && state.activeTab === 'preview');
        if (d.viewDoc) d.viewDoc.classList.toggle('active', space === 'canvas');

        renderPreviewTools(d);
        renderPreviewBar(d);
        if (d.btnRefresh) {
            d.btnRefresh.style.display = artifacts && state.activeTab === 'preview' ? '' : 'none';
            d.btnRefresh.disabled = state.activeTab !== 'preview' || !previewTarget();
        }

        if (artifacts && state.activeTab === 'preview' && state.previewDirty) {
            refreshPreview();
        }
    }

    // Canvas : vue texte
    // Rendu reconstruit seulement si le texte change d'ailleurs ; frappe comme la vue Code

    const TIP_KEY = 'davidtwentyai-canvas-tip-seen';

    function tipSeen() {
        try { return localStorage.getItem(TIP_KEY) === '1'; } catch (e) { return true; }
    }

    function markTipSeen() {
        if (tipSeen()) return;
        try { localStorage.setItem(TIP_KEY, '1'); } catch (e) { }
        const d = dom();
        if (d.docTip) d.docTip.hidden = true;
    }

    function appendedForView(src, partial) {
        if (!src || !src.trim()) return partial;
        return startsLike(partial, src) ? partial : appendContinuation(src, partial);
    }

    function renderDocView(d) {
        const view = state._doc;
        if (!view) return;
        const doc = activeDoc();
        const text = doc ? state.files[doc] : '';
        const st = state.streamingFile;
        const s = st && st.family === 'canvas' && (st.name === doc || (!(st.name in state.files) && state.selectedFile === st.name)) ? st : null;
        if (state.editSession && state.editSession !== doc) endEditSession();
        let what = '';
        if (s && s.family === 'canvas' && s.kind === 'file' && (typeof s.partial === 'string' || !(s.name in state.files)) && !s.keepDoc) {
            const partial = s.partial || '';
            view.setStreaming(s.append ? appendedForView(text, partial) : partial);
            what = 'L\'IA écrit le texte…';
        } else if (state.showDiff && doc && (state.baseline[doc] || '') !== text) {
            view.showDiff(state.baseline[doc] || '', text);
        } else {
            view.setText(text);
            view.setEditable(!!doc && !docReadOnlyReason(doc));
            if (s && s.family === 'canvas') what = 'L\'IA modifie le texte…';
            if (state._docFlash && state._docFlash.after === text) {
                const f = state._docFlash;
                state._docFlash = null;
                view.flashChanges(f.before, f.after);
            }
        }
        if (d.docState) d.docState.textContent = what;
        if (d.docTip) d.docTip.hidden = !view.editable || tipSeen();
        renderReadOnlyHint(d);
    }

    function renderEmptyState(d) {
        const manage = canManageFiles();
        const why = manageBlockedReason();
        for (const [b, title] of [[d.emptyNewDoc, 'Créer un texte vide dans le Canvas'],
            [d.emptyImportDoc, `Importer un document dans le Canvas\u00a0: ${DOC_FORMATS_TEXT} (vous pouvez aussi le glisser ici)`],
            [d.emptyNewFile, 'Créer un fichier dans les Artifacts'], [d.emptyImport, 'Importer des fichiers, un dossier ou un ZIP (vous pouvez aussi les glisser ici)']]) {
            if (!b) continue;
            b.disabled = !manage;
            b.title = why || title;
        }
    }

    function createDoc() {
        if (!canManageFiles() || allFileNames().length) return;
        endEditSession();
        pushHistory();
        state.files[DEFAULT_DOC_NAME] = '';
        state.selectedFile = DEFAULT_DOC_NAME;
        state.docTitles = Object.create(null);
        state.showDiff = false;
        afterFilesChanged('canvas');
        if (state._doc) state._doc.focusEnd();
    }

    /* Un brouillon déjà tapé est gardé ; saisie native (insertText) pour que Cmd+Z le retire */
    function fillPrompt(text) {
        const input = document.getElementById('prompt-input');
        if (!input) return;
        input.focus();
        const draft = input.value;
        let add = text;
        if (draft.trim()) {
            input.setSelectionRange(draft.length, draft.length);
            add = (/\n[ \t]*\n[ \t]*$/.test(draft) ? '' : /\n[ \t]*$/.test(draft) ? '\n' : '\n\n') + text;
        } else {
            input.select();
        }
        let ok = false;
        try { ok = document.execCommand('insertText', false, add); } catch (e) { ok = false; }
        if (!ok || !input.value.endsWith(text)) {
            input.value = draft.trim() ? draft + add : text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (window.innerWidth <= 900) hidePanel();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }

    // --- Documents du Canvas : onglets ---

    const DOC_TAB_CLOSE_ICON = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    const DOC_TAB_ADD_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

    function renderDocTabs(d) {
        const bar = d.docTabs;
        if (!bar) return;
        const names = docNamesOf(state.files);
        const s = state.streamingFile;
        const writing = s && s.family === 'canvas' && s.name && !(s.name in state.files) ? s.name : null;
        const show = state.mode === 'canvas' && (names.length > 0 || !!writing);
        bar.hidden = !show;
        if (!show) return;
        const active = writing && state.selectedFile === writing ? writing : activeDoc();
        const manage = canManageFiles();
        const titleOf = n => n === writing ? (resolveDocTitle(s.title || '', s.partial || '', '') || 'Nouveau document') : (docTitleIn(state.files, state.docTitles, n) || 'Sans titre');
        const list = writing ? [...names, writing] : names;
        const key = JSON.stringify([list, list.map(titleOf), active, writing, manage]);
        if (bar._key === key) return;
        bar._key = key;
        bar.textContent = '';
        const movable = manage && names.length > 1;
        for (const n of list) {
            const tab = document.createElement('div');
            tab.className = 'canvas-doc-tab' + (n === active ? ' is-active' : '') + (n === writing || (s && s.name === n) ? ' is-writing' : '');
            tab.dataset.doc = n;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'canvas-doc-tab-name';
            btn.setAttribute('role', 'tab');
            btn.setAttribute('aria-selected', String(n === active));
            btn.textContent = titleOf(n);
            btn.title = titleOf(n) + (n === writing ? ' · l\'IA l\'écrit' : manage ? ' · double-clic pour renommer' + (movable ? ', glisser pour déplacer' : '') : '');
            // Le clic qui termine un glisser ne choisit pas l'onglet
            btn.addEventListener('click', () => { if (!(bar._dragEndedAt > performance.now() - 300)) selectDoc(n); });
            btn.addEventListener('dblclick', () => { if (n in state.files) { selectDoc(n); startDocRename(); } });
            if (movable && n !== writing) {
                tab.addEventListener('pointerdown', (e) => docTabDragStart(e, tab, bar));
                btn.addEventListener('keydown', (e) => {
                    if (!e.altKey || e.ctrlKey || e.metaKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
                    e.preventDefault();
                    const order = docNamesOf(state.files);
                    const at = order.indexOf(n), to = at + (e.key === 'ArrowLeft' ? -1 : 1);
                    if (at < 0 || to < 0 || to >= order.length) return;
                    order.splice(at, 1);
                    order.splice(to, 0, n);
                    if (reorderDocs(order)) {
                        const again = [...bar.querySelectorAll('.canvas-doc-tab')].find(t => t.dataset.doc === n);
                        if (again) again.querySelector('.canvas-doc-tab-name').focus();
                    }
                });
            }
            tab.appendChild(btn);
            if (n !== writing) {
                const close = document.createElement('button');
                close.type = 'button';
                close.className = 'canvas-doc-tab-close';
                close.innerHTML = DOC_TAB_CLOSE_ICON;
                close.disabled = !manage;
                close.title = manageBlockedReason() || `Supprimer le document « ${titleOf(n)} »`;
                close.setAttribute('aria-label', close.title);
                close.addEventListener('click', (e) => { e.stopPropagation(); deleteDoc(n); });
                tab.appendChild(close);
            }
            bar.appendChild(tab);
        }
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'canvas-doc-tab-add';
        add.innerHTML = DOC_TAB_ADD_ICON;
        add.disabled = !manage;
        add.title = manageBlockedReason() || 'Nouvel onglet ou importer un document';
        add.setAttribute('aria-label', add.title);
        add.setAttribute('aria-haspopup', 'menu');
        add.setAttribute('aria-expanded', String(!!(d.docAddMenu && !d.docAddMenu.hidden)));
        add.addEventListener('click', () => setDocAddMenu(!!(d.docAddMenu && d.docAddMenu.hidden)));
        bar.appendChild(add);
        // Mesurés à l'image suivante (la vue texte peut encore être masquée pendant ce rendu)
        requestAnimationFrame(() => { revealActiveDocTab(bar); syncDocTabsBaseline(bar); syncDocTabsOverflow(d); });
        if (!bar._baselineObserver && typeof ResizeObserver === 'function') {
            bar._baselineObserver = new ResizeObserver(() => { revealActiveDocTab(bar); syncDocTabsBaseline(bar); syncDocTabsOverflow(d); });
            bar._baselineObserver.observe(bar);
        }
    }

    /* Onglets qui dépassent : flèches ‹ › (sans trackpad, rien ne les faisait défiler), fondus aux bords
       qui en cachent, et pas de croix sur un onglet en partie caché (un clic au bord le supprimait) */
    const DOC_TABS_FADE = 20;
    function syncDocTabsOverflow(d) {
        const bar = d.docTabs, prev = d.docTabsPrev, next = d.docTabsNext;
        if (!bar || !prev || !next) return;
        const over = !bar.hidden && bar.scrollWidth > bar.clientWidth + 1;
        const atStart = !over || bar.scrollLeft <= 1;
        const atEnd = !over || bar.scrollLeft >= bar.scrollWidth - bar.clientWidth - 1;
        prev.hidden = next.hidden = !over;
        prev.disabled = atStart;
        next.disabled = atEnd;
        const fadeL = atStart ? 0 : DOC_TABS_FADE, fadeR = atEnd ? 0 : DOC_TABS_FADE;
        bar.style.setProperty('--fade-l', fadeL + 'px');
        bar.style.setProperty('--fade-r', fadeR + 'px');
        const box = bar.getBoundingClientRect();
        for (const tab of bar.querySelectorAll('.canvas-doc-tab')) {
            const t = tab.getBoundingClientRect();
            tab.classList.toggle('is-clipped', over && (t.left < box.left + fadeL - 1 || t.right > box.right - fadeR + 1));
        }
    }

    function scrollDocTabs(dir) {
        const bar = dom().docTabs;
        if (!bar) return;
        const smooth = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        bar.scrollBy({ left: dir * Math.max(120, bar.clientWidth * 0.7), behavior: smooth ? 'smooth' : 'auto' });
    }

    function revealActiveDocTab(bar) {
        const cur = bar.querySelector('.canvas-doc-tab.is-active');
        if (!cur || !bar.clientWidth) return;
        const next = cur.nextElementSibling;
        const end = next && next.classList.contains('canvas-doc-tab-add') ? next : cur;
        const l = cur.offsetLeft, r = end.offsetLeft + end.offsetWidth, room = DOC_TABS_FADE + 8;
        if (l < bar.scrollLeft + room) bar.scrollLeft = Math.max(0, l - room);
        else if (r > bar.scrollLeft + bar.clientWidth - room) bar.scrollLeft = r - bar.clientWidth + room;
    }

    /* Le trait est le fond de la barre (style.css) : coupé entre --tab-gap-l et --tab-gap-r */
    function syncDocTabsBaseline(bar) {
        const cur = bar.querySelector('.canvas-doc-tab.is-active');
        // Bords mesurés à l'écran (sous-pixel, glisser compris), ramenés au contenu défilant de la barre
        const box = bar.getBoundingClientRect();
        const t = cur ? cur.getBoundingClientRect() : null;
        const at = x => Math.round((x - box.left - bar.clientLeft + bar.scrollLeft) * 100) / 100;
        const l = t ? at(t.left) : 0;
        const r = t ? at(t.right) : 0;
        bar.style.setProperty('--tab-gap-l', l + 'px');
        bar.style.setProperty('--tab-gap-r', r + 'px');
    }

    function setDocAddMenu(open) {
        const d = dom();
        const menu = d.docAddMenu;
        if (!menu) return;
        const add = d.docTabs ? d.docTabs.querySelector('.canvas-doc-tab-add') : null;
        open = !!open && !!add && !add.disabled && state.mode === 'canvas';
        if (menu.hidden === !open) return;
        menu.hidden = !open;
        if (add) add.setAttribute('aria-expanded', String(open));
        if (!open) return;
        const barBox = menu.parentElement.getBoundingClientRect();
        const b = add.getBoundingClientRect();
        menu.style.left = Math.max(8, Math.min(Math.round(b.left - barBox.left), Math.round(barBox.width - menu.offsetWidth - 8))) + 'px';
        const first = menu.querySelector('button');
        if (first) first.focus();
    }

    function setImportMenu(open, anchor) {
        const d = dom();
        const menu = d.importMenu;
        if (!menu) return;
        open = !!open && !!anchor && canManageFiles();
        if (state._importAnchor) state._importAnchor.setAttribute('aria-expanded', 'false');
        menu.hidden = !open;
        state._importAnchor = open ? anchor : null;
        if (!open) return;
        anchor.setAttribute('aria-expanded', 'true');
        // Coordonnées bordure comprise (le menu se place depuis l'intérieur de la bordure)
        const r = d.panel.getBoundingClientRect();
        const top = r.top + d.panel.clientTop, left = r.left + d.panel.clientLeft;
        const b = anchor.getBoundingClientRect();
        const below = b.bottom - top + 4;
        const fits = below + menu.offsetHeight + 8 <= d.panel.clientHeight;
        menu.style.top = (fits ? below : Math.max(8, b.top - top - 4 - menu.offsetHeight)) + 'px';
        menu.style.left = Math.max(4, Math.min(b.left - left, d.panel.clientWidth - menu.offsetWidth - 4)) + 'px';
        menu.style.right = 'auto';
        const first = menu.querySelector('button');
        if (first) first.focus();
    }

    /* Au doigt la barre défile ; positions lues en offsetLeft, sans les décalages animés ; Échap annule */
    function docTabDragStart(e, tab, bar) {
        if (e.button !== 0 || e.pointerType === 'touch' || e.target.closest('.canvas-doc-tab-close') || state._renamingDoc) return;
        const startX = e.clientX;
        const contentX = (clientX) => clientX - bar.getBoundingClientRect().left - bar.clientLeft + bar.scrollLeft;
        const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        let dragging = false, grab = 0, lastX = startX;
        const place = () => {
            const x = contentX(lastX);
            const mid = x - grab + tab.offsetWidth / 2;
            const others = [...bar.querySelectorAll('.canvas-doc-tab')].filter(t => t !== tab);
            const before = others.find(t => mid < t.offsetLeft + t.offsetWidth / 2) || bar.querySelector('.canvas-doc-tab-add');
            if (tab.nextElementSibling !== before) {
                const was = new Map(others.map(t => [t, t.offsetLeft]));
                bar.insertBefore(tab, before);
                if (!calm) for (const t of others) {
                    const dx = was.get(t) - t.offsetLeft;
                    if (dx) t.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 140, easing: 'ease-out' });
                }
            }
            tab.style.transform = `translateX(${Math.round(x - grab - tab.offsetLeft)}px)`;
            syncDocTabsBaseline(bar);
        };
        const move = (ev) => {
            if (ev.pointerId !== e.pointerId) return;
            lastX = ev.clientX;
            if (!dragging) {
                if (Math.abs(lastX - startX) < 5) return;
                if (!canManageFiles() || !tab.isConnected) { stop(false); return; }
                dragging = true;
                grab = contentX(startX) - tab.offsetLeft;
                tab.classList.add('is-dragging');
                bar.classList.add('is-reordering');
            }
            const r = bar.getBoundingClientRect();
            if (lastX < r.left + 24) bar.scrollLeft -= 8;
            else if (lastX > r.right - 24) bar.scrollLeft += 8;
            place();
        };
        const up = (ev) => { if (ev.pointerId === e.pointerId) stop(ev.type === 'pointerup'); };
        const key = (ev) => {
            if (ev.key !== 'Escape' || !dragging) return;
            ev.preventDefault();
            ev.stopPropagation();
            stop(false);
        };
        const stop = (commit) => {
            window.removeEventListener('pointermove', move, true);
            window.removeEventListener('pointerup', up, true);
            window.removeEventListener('pointercancel', up, true);
            window.removeEventListener('keydown', key, true);
            if (!dragging) return;
            dragging = false;
            bar._dragEndedAt = performance.now();
            tab.classList.remove('is-dragging');
            bar.classList.remove('is-reordering');
            tab.style.transform = '';
            syncDocTabsBaseline(bar);
            const order = [...bar.querySelectorAll('.canvas-doc-tab')].map(t => t.dataset.doc);
            if (!commit || !reorderDocs(order)) { bar._key = null; renderDocTabs(dom()); }
        };
        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerup', up, true);
        window.addEventListener('pointercancel', up, true);
        window.addEventListener('keydown', key, true);
    }

    /* Ordre des onglets, des listes envoyées à l'IA et du ZIP ; vrai si l'ordre a changé */
    function reorderDocs(order) {
        const names = docNamesOf(state.files);
        if (!canManageFiles() || state.mode !== 'canvas' || order.length !== names.length
            || new Set(order).size !== names.length || order.some(n => !(n in state.files))
            || order.every((n, i) => n === names[i])) return false;
        endEditSession();
        pushHistory();
        // Sans changer l'objet state.files (d'autres le tiennent)
        const texts = order.map(n => state.files[n]);
        for (const n of order) delete state.files[n];
        order.forEach((n, i) => { state.files[n] = texts[i]; });
        afterFilesChanged('canvas');
        return true;
    }

    /* Le document affiché devient celui que l'IA voit en premier */
    function selectDoc(name) {
        if (state.mode !== 'canvas' || !name || (!(name in state.files) && !(state.streamingFile && state.streamingFile.name === name))) return;
        if (state.selectedFile === name) return;
        endEditSession();
        const names = docNamesOf(state.files);
        const dir = names.indexOf(name) < names.indexOf(state.selectedFile) ? -1 : 1;
        state.selectedFile = name;
        if (state.streamingFile) {
            state._streamSelectPinned = name;
            state._streamSelectManual = true;
            state._turnPicked = true;
        }
        render();
        animateDocSwitch(dir);
        notifyStateChange();
        schedulePersist();
    }

    /* Simple fondu si l'utilisateur limite les animations ; un nouveau changement remplace l'animation */
    function animateDocSwitch(dir) {
        const page = document.getElementById('canvas-doc-page');
        if (!page || typeof page.animate !== 'function') return;
        const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        if (state._docSwitchAnim) state._docSwitchAnim.cancel();
        state._docSwitchAnim = page.animate(reduce
            ? [{ opacity: 0.4 }, { opacity: 1 }]
            : [{ opacity: 0, transform: `translateX(${dir * 16}px)` }, { opacity: 1, transform: 'none' }],
            { duration: reduce ? 120 : 220, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });
        state._docSwitchAnim.onfinish = state._docSwitchAnim.oncancel = function () { if (state._docSwitchAnim === this) state._docSwitchAnim = null; };
    }

    function newDocument() {
        if (!canManageFiles() || state.mode !== 'canvas') return;
        endEditSession();
        pushHistory();
        const name = freeDocName(state.files, 'document');
        state.files[name] = '';
        // Un titre par défaut, libre : jamais deux documents du même titre pour l'IA
        const taken = new Set(docNamesOf(state.files).map(n => docTitleIn(state.files, state.docTitles, n)));
        let k = docNamesOf(state.files).length;
        while (taken.has(`Document ${k}`)) k++;
        state.docTitles[name] = `Document ${k}`;
        state.selectedFile = name;
        state.showDiff = false;
        afterFilesChanged('canvas');
        animateDocSwitch(1);
        if (state._doc) state._doc.focusEnd();
    }

    /* Le dernier aussi : le Canvas est alors vide, comme avec « Vider » */
    async function deleteDoc(name) {
        if (!canManageFiles() || state.mode !== 'canvas' || !(name in state.files)) return;
        // Autre conversation chargée pendant la confirmation : rien n'est supprimé
        const seq = state._loadSeq;
        const title = docTitleIn(state.files, state.docTitles, name) || 'Sans titre';
        const last = docNamesOf(state.files).length === 1;
        if (String(state.files[name]).trim()) {
            const msg = last
                ? `Supprimer le document «\u00a0${title}\u00a0»\u00a0? C'est le dernier\u00a0: le Canvas sera vide, et la conversation pourra ensuite utiliser les Artifacts ou le Canvas.`
                : `Supprimer le document «\u00a0${title}\u00a0»\u00a0? L'historique des versions permet de le retrouver.`;
            const ok = typeof window.customConfirm === 'function'
                ? await window.customConfirm(msg, { icon: 'delete', okLabel: 'Supprimer', danger: true })
                : window.confirm(msg);
            if (!ok || seq !== state._loadSeq || !canManageFiles() || !(name in state.files)) return;
        }
        endEditSession();
        pushHistory();
        const names = docNamesOf(state.files);
        const at = names.indexOf(name);
        delete state.files[name];
        delete state.docTitles[name];
        if (last) {
            state.selectedFile = null;
            state.showDiff = false;
            afterFilesChanged();
            return;
        }
        const shown = state.selectedFile === name || !(state.selectedFile in state.files);
        if (shown) state.selectedFile = names[at + 1] || names[at - 1] || null;
        state.showDiff = false;
        afterFilesChanged('canvas');
        if (shown) animateDocSwitch(names[at + 1] ? 1 : -1);
        flashStatus(`Document «\u00a0${title}\u00a0» supprimé`, '');
    }

    // --- Titre du texte : renommage dans l'en-tête ---

    function startDocRename() {
        const d = dom();
        const doc = activeDoc();
        if (!doc || !d.docTitle || !canManageFiles() || state._renamingDoc) return;
        endEditSession();
        const current = shownDocTitle();
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'canvas-name-input canvas-doc-title-input';
        input.value = current;
        input.placeholder = 'Sans titre';
        input.maxLength = 200;
        input.setAttribute('aria-label', 'Titre du texte');
        let done = false;
        const finish = (commit) => {
            if (done) return;
            done = true;
            state._renamingDoc = null;
            input.remove();
            d.docTitle.hidden = false;
            if (commit) {
                const t = input.value.replace(/\s+/g, ' ').trim().slice(0, 200);
                if (t !== current && doc in state.files && state.mode === 'canvas' && canManageFiles()) {
                    pushHistory();
                    state.docTitles[doc] = t;
                    render();
                    notifyStateChange();
                    persistNow();
                    return;
                }
            }
            render();
        };
        input.addEventListener('keydown', (e) => {
            if (e.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
        });
        input.addEventListener('blur', () => finish(true));
        state._renamingDoc = { finish };
        d.docTitle.hidden = true;
        d.docTitle.after(input);
        input.focus();
        input.select();
    }

    // --- Télécharger (.md, .html, .txt) et Copier le texte ---

    function setDownloadMenu(open) {
        const d = dom();
        if (!d.downloadMenu) return;
        d.downloadMenu.hidden = !open;
        if (d.btnDownload) {
            d.btnDownload.setAttribute('aria-expanded', String(!!open));
            d.btnDownload.classList.toggle('is-active', !!open);
        }
        if (open && d.downloadAll) d.downloadAll.hidden = !(state.mode === 'canvas' && docNamesOf(state.files).length > 1);
        if (open) {
            const head = d.downloadMenu.parentElement.getBoundingClientRect();
            const b = d.btnDownload ? d.btnDownload.getBoundingClientRect() : head;
            d.downloadMenu.style.right = Math.max(8, Math.round(head.right - b.right)) + 'px';
            const first = d.downloadMenu.querySelector('button');
            if (first) first.focus();
        }
    }

    function downloadBaseName(title, fallback) {
        const t = String(title || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').slice(0, 60).trim();
        return t || fallback;
    }

    function saveBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    const DOC_EXPORT_CSS = 'body{margin:0;background:#fff;color:#1a1a1a;font:17px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}' +
        'main{max-width:720px;margin:0 auto;padding:56px 32px}main>:first-child{margin-top:0}main>:last-child{margin-bottom:0}' +
        'h1,h2,h3,h4,h5,h6{line-height:1.3;margin:1.4em 0 .5em}h1{font-size:1.9em}h2{font-size:1.45em}h3{font-size:1.2em}' +
        'p,ul,ol,blockquote,pre,table{margin:0 0 1em}ul,ol{padding-left:1.6em}li>ul,li>ol{margin:.2em 0}' +
        'blockquote{margin-left:0;padding:.1em 0 .1em 1em;border-left:3px solid #d0d0d0;color:#555}' +
        'code{font:.88em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#f2f2f2;border-radius:4px;padding:1px 5px}' +
        'pre{background:#f5f5f5;border-radius:8px;padding:14px 16px;overflow:auto}pre code{background:none;padding:0}' +
        'table{border-collapse:collapse}th,td{border:1px solid #ddd;padding:6px 12px}th{background:#f6f6f6}' +
        'a{color:#2563eb}img{max-width:100%}hr{border:0;border-top:1px solid #ddd;margin:2em 0}' +
        '@media print{main{padding:0}a{color:inherit}}';

    function downloadDoc(format) {
        setDownloadMenu(false);
        if (format === 'zip') { downloadAllDocs(); return; }
        const doc = activeDoc();
        if (!doc || !window.CanvasDoc) return;
        const md = state.files[doc];
        const title = shownDocTitle();
        const base = downloadBaseName(title, doc.replace(/\.(?:md|markdown)$/i, '') || 'texte');
        if (format === 'html') {
            const html = '<!DOCTYPE html>\n<html lang="fr">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
                '<title>' + escapeHtml(title || base) + '</title>\n<style>' + DOC_EXPORT_CSS + '</style>\n</head>\n<body>\n<main>\n' +
                window.CanvasDoc.renderHtml(md) + '\n</main>\n</body>\n</html>\n';
            saveBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), base + '.html');
        } else if (format === 'txt') {
            saveBlob(new Blob([window.CanvasDoc.toPlainText(md) + '\n'], { type: 'text/plain;charset=utf-8' }), base + '.txt');
        } else {
            saveBlob(new Blob([md], { type: 'text/markdown;charset=utf-8' }), base + '.md');
        }
    }

    function downloadAllDocs() {
        if (state.mode !== 'canvas') return;
        const out = Object.create(null);
        for (const n of docNamesOf(state.files)) {
            const base = downloadBaseName(docTitleIn(state.files, state.docTitles, n), n.replace(/\.(?:md|markdown)$/i, '') || 'document');
            let name = base + '.md';
            for (let i = 2; name in out; i++) name = `${base} (${i}).md`;
            out[name] = state.files[n];
        }
        let base = 'documents';
        try { if (typeof conversationTitle === 'string' && conversationTitle.trim()) base = downloadBaseName(conversationTitle, base); } catch (e) { }
        saveBlob(buildZip(out), base + '.zip');
    }

    const COPY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
    const COPIED_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

    async function copyDocText() {
        const d = dom();
        const doc = activeDoc();
        if (!doc || !window.CanvasDoc) return;
        const md = state.files[doc];
        const html = window.CanvasDoc.renderHtml(md);
        const plain = window.CanvasDoc.toPlainText(md);
        let ok = false;
        try {
            if (navigator.clipboard && typeof window.ClipboardItem === 'function') {
                await navigator.clipboard.write([new ClipboardItem({
                    'text/html': new Blob([html], { type: 'text/html' }),
                    'text/plain': new Blob([plain], { type: 'text/plain' })
                })]);
                ok = true;
            }
        } catch (e) { /* refusé : autre méthode */ }
        if (!ok) {
            // Repli : copie d'une sélection hors écran (garde la mise en forme)
            const box = document.createElement('div');
            box.setAttribute('aria-hidden', 'true');
            box.style.cssText = 'position:fixed;left:-9999px;top:0;white-space:pre-wrap';
            box.innerHTML = html;
            d.panel.appendChild(box);
            const sel = window.getSelection();
            const saved = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
            const r = document.createRange();
            r.selectNodeContents(box);
            sel.removeAllRanges();
            sel.addRange(r);
            try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
            sel.removeAllRanges();
            if (saved) sel.addRange(saved);
            box.remove();
        }
        if (!ok) { flashStatus('Copie impossible : le navigateur l\'a refusée', '', true); return; }
        if (d.btnCopy) {
            clearTimeout(state._copyTimer);
            d.btnCopy.innerHTML = COPIED_ICON + '<span>Copié</span>';
            d.btnCopy.title = 'Texte copié';
            d.btnCopy.classList.add('is-done');
            state._copyTimer = setTimeout(() => {
                d.btnCopy.innerHTML = COPY_ICON + '<span>Copier</span>';
                d.btnCopy.title = 'Copier le texte (mis en forme et en texte brut)';
                d.btnCopy.classList.remove('is-done');
            }, 1500);
        }
    }

    // --- Échap : d'abord le calque ouvert dans le volet, jamais le volet ---

    function modalOpen() {
        return Array.from(document.querySelectorAll('.custom-dialog-overlay, .sp-modal-overlay, .budget-alert-overlay'))
            .some(el => el.style.display !== 'none' && el.getClientRects().length > 0);
    }

    function innerLayerOpen() {
        const d = dom();
        return !!(state._renamingDoc || (d.downloadMenu && !d.downloadMenu.hidden) || (d.docAddMenu && !d.docAddMenu.hidden) || (d.importMenu && !d.importMenu.hidden) || (d.previewMenu && !d.previewMenu.hidden) || (codeFilesMenuShown() && !state.naming) || (state._doc && state._doc.hasLayer()));
    }

    function closeInnerLayer() {
        const d = dom();
        if (state._renamingDoc) { state._renamingDoc.finish(false); return true; }
        if (d.downloadMenu && !d.downloadMenu.hidden) {
            setDownloadMenu(false);
            if (d.btnDownload) d.btnDownload.focus();
            return true;
        }
        if (d.docAddMenu && !d.docAddMenu.hidden) {
            setDocAddMenu(false);
            const add = d.docTabs && d.docTabs.querySelector('.canvas-doc-tab-add');
            if (add) add.focus();
            return true;
        }
        if (d.importMenu && !d.importMenu.hidden) {
            const anchor = state._importAnchor;
            setImportMenu(false);
            if (anchor) anchor.focus();
            return true;
        }
        if (d.previewMenu && !d.previewMenu.hidden) {
            setPreviewMenu(false);
            if (d.previewFileBtn) d.previewFileBtn.focus();
            return true;
        }
        if (codeFilesMenuShown() && !state.naming) {
            setCodeFilesOpen(false);
            d.codeFileBtn.focus();
            return true;
        }
        return !!(state._doc && state._doc.dismiss());
    }

    function mountDocView(d) {
        if (state._doc || !d.viewDoc || !d.docPage || !d.docScroll || !window.CanvasDoc) return;
        state._doc = window.CanvasDoc.createView({ root: d.viewDoc, page: d.docPage, scroller: d.docScroll }, {
            getText() {
                const doc = activeDoc();
                return doc ? state.files[doc] : '';
            },
            onEdit(md) {
                const doc = activeDoc();
                if (!doc || docReadOnlyReason(doc)) return;
                if (md === state.files[doc]) return;
                // Première frappe de la séance : l'état d'avant devient une version
                if (state.editSession !== doc) {
                    endEditSession();
                    pushHistory();
                    state.editSession = doc;
                    renderHistoryUi(dom());
                }
                state.files[doc] = md;
                state.previewDirty = true;
                schedulePersist();
                scheduleLiveStats();
                const dd = dom();
                if (dd.btnCopy) dd.btnCopy.disabled = !md.trim();
            },
            onBlur: endEditSession,
            onReadOnlyClick: nudgeReadOnlyHint,
            // Forme canonique du texte : même rendu, donc ni nouvelle version, ni modification à signaler
            normalizeText(md) {
                const doc = activeDoc();
                if (!doc || state.files[doc] === md) return;
                const old = state.files[doc];
                state.files[doc] = md;
                if (state.aiFiles[doc] === old) state.aiFiles[doc] = md;
                if (state.baseline[doc] === old) state.baseline[doc] = md;
                persistNow();
            },
            askBlocker() {
                if (state.locked) return 'Aperçu\u00a0: la conversation est en lecture seule';
                if (state.busy) return 'Patientez : l\'IA est en train de répondre';
                return typeof window.canvasAskBlocker === 'function' ? window.canvasAskBlocker() : '';
            },
            sendAsk(instruction, focus, onCancel) {
                const doc = activeDoc();
                if (!doc || typeof window.sendCanvasAsk !== 'function') return false;
                endEditSession();
                return !!window.sendCanvasAsk(instruction, { docName: doc, start: focus.start, end: focus.end, excerpt: focus.excerpt, instruction }, onCancel);
            },
            onToolbarUsed: markTipSeen,
            flash(text, error) { flashStatus(text, text, error); },
            lineDiff,
            save: flushPersist,
            modalOpen
        });
    }

    function setTab(tab) {
        if (tab !== 'code' && tab !== 'preview') return;
        const wasPreview = state.activeTab === 'preview';
        state.activeTab = tab;
        // Iframe vidée par about:blank, pas srcdoc='' : certains navigateurs ne renavigueraient pas au retour
        if (wasPreview && tab !== 'preview') {
            setPreviewTool(null);
            setPreviewLoading(false);
            blankPreview();
            state.previewDirty = true;
        }
        render();
    }

    // ---------- Preview ----------

    function isHtmlFile(name) { return /\.html?$/i.test(name); }
    function isMarkdownFile(name) { return /\.(md|markdown)$/i.test(name); }
    function isTextFile(name) { return /\.txt$/i.test(name); }
    /* null pour le code et les données : leur aperçu serait le même que l'onglet Code */
    function previewKind(name) {
        // Fichier que l'IA ne lit pas : seule une image a un aperçu
        if (state.files[name] == null && isAsset(name)) return /\.(?:svg|png|jpe?g|gif|webp|avif|ico|bmp)$/i.test(name) ? 'image' : null;
        if (isHtmlFile(name)) return 'page';
        if (isMarkdownFile(name) || isTextFile(name)) return 'document';
        if (/\.(?:svg|png|jpe?g|gif|webp|avif|ico|bmp)$/i.test(name)) return 'image';
        if (/\.(csv|tsv)$/i.test(name)) return 'table';
        return null;
    }
    function isPreviewable(name) { return !!name && !!previewKind(name); }

    /* Feuille de style ou script : son effet se voit sur la page qui le charge */
    function isPageAsset(name) { return /\.(css|js|mjs)$/i.test(name); }

    function pagesUsing(asset) {
        return sortFileNames(Object.keys(state.files)).filter((page) => {
            if (!isHtmlFile(page)) return false;
            const re = /<link\b[^>]*\bhref="([^"]+)"[^>]*>|<script\b[^>]*\bsrc="([^"]+)"[^>]*>/gi;
            let m;
            while ((m = re.exec(state.files[page]))) {
                if (resolvePath(m[1] || m[2], page) === asset) return true;
            }
            return false;
        });
    }

    /* Choisi s'il a un aperçu, sinon la page qui charge ce style/script ; jamais un fichier sans rapport */
    function previewTarget() {
        const has = (n) => fileExists(n);
        const sel = has(state.selectedFile) ? state.selectedFile : null;
        const nav = state.previewNav;
        if (nav && nav.from === sel && has(nav.page)) return nav.page;
        if (sel) {
            if (isPreviewable(sel)) return sel;
            if (!isPageAsset(sel)) return null;
            const pages = pagesUsing(sel);
            if (pages.includes(state.previewCurrentFile)) return state.previewCurrentFile;
            if (pages.includes(state.entrypoint)) return state.entrypoint;
            return pages[0] || null;
        }
        if (isPreviewable(state.entrypoint) && has(state.entrypoint)) return state.entrypoint;
        const names = sortFileNames(allFileNames());
        return names.find(n => isHtmlFile(n) && state.files[n] != null) || names.find(isPreviewable) || null;
    }

    // ---------- Barre d'adresse de l'aperçu ----------

    const PREVIEW_KIND_ICONS = {
        page: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
        document: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>',
        image: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
        table: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>'
    };
    const PREVIEW_KIND_GROUPS = [['page', 'Pages'], ['document', 'Documents'], ['image', 'Images'], ['table', 'Tableaux']];

    function previewFiles() { return sortFileNames(allFileNames()).filter(isPreviewable); }

    function renderPreviewBar(d) {
        if (!d.previewBar) return;
        const target = displayMode() === 'artifacts' && state.activeTab === 'preview' ? previewTarget() : null;
        const show = !!target && previewFiles().length > 1;
        d.previewBar.hidden = !show;
        if (d.viewPreview) d.viewPreview.classList.toggle('has-bar', show);
        if (!show) { setPreviewMenu(false); return; }
        d.previewFileIcon.innerHTML = PREVIEW_KIND_ICONS[previewKind(target)] || '';
        d.previewFileName.textContent = target;
    }

    function setPreviewMenu(open) {
        const d = dom();
        if (!d.previewMenu || d.previewMenu.hidden === !open) return;
        if (open) fillPreviewMenu(d);
        d.previewMenu.hidden = !open;
        d.previewFileBtn.setAttribute('aria-expanded', String(!!open));
        d.previewFileBtn.classList.toggle('is-active', !!open);
        if (open) {
            const item = d.previewMenu.querySelector('[aria-checked="true"]') || d.previewMenu.querySelector('button');
            if (item) item.focus();
        }
    }

    function fillPreviewMenu(d) {
        const current = previewTarget();
        const files = previewFiles();
        const groups = PREVIEW_KIND_GROUPS.map(([kind, label]) => [kind, label, files.filter(n => previewKind(n) === kind)]).filter(g => g[2].length);
        d.previewMenu.textContent = '';
        for (const [kind, label, names] of groups) {
            if (groups.length > 1) {
                const head = document.createElement('div');
                head.className = 'canvas-preview-menu-group';
                head.setAttribute('role', 'presentation');
                head.textContent = label;
                d.previewMenu.appendChild(head);
            }
            for (const name of names) {
                const item = document.createElement('button');
                item.type = 'button';
                item.setAttribute('role', 'menuitemradio');
                item.setAttribute('aria-checked', String(name === current));
                item.dataset.file = name;
                item.innerHTML = PREVIEW_KIND_ICONS[kind];
                const text = document.createElement('span');
                text.textContent = name;
                item.appendChild(text);
                d.previewMenu.appendChild(item);
            }
        }
    }

    /* Fichier choisi dans la barre : choisi aussi dans l'onglet Code */
    function choosePreviewFile(name) {
        setPreviewMenu(false);
        if (!fileExists(name) || !isPreviewable(name)) return;
        if (name !== previewTarget()) {
            state.selectedFile = name;
            state._streamSelectPinned = name;
            state._streamSelectManual = !!(state.streamingFile || state.busy);
            if (state._streamSelectManual) state._turnPicked = true;
            state.previewNav = null;
            state.previewHash = '';
            state.previewDirty = true;
        }
        render();
        const d = dom();
        if (d.previewFileBtn) d.previewFileBtn.focus();
    }

    function noPreviewReason() {
        const sel = fileExists(state.selectedFile) ? state.selectedFile : null;
        if (sel && isPageAsset(sel)) return `« ${sel} » n'est chargé par aucune page des Artifacts : son contenu est dans l'onglet Code.`;
        if (sel) return `« ${sel} » n'a pas d'aperçu : son contenu est dans l'onglet Code.`;
        if (!allFileNames().length) return 'Rien à prévisualiser : il n\'y a encore aucun fichier.';
        return 'Rien à prévisualiser : les Artifacts ne contiennent ni page web, ni document, ni image, ni tableau.';
    }

    /* Dernier fichier sans aperçu : on montre plutôt une page ou un document écrit dans ce tour */
    /* chosen : fichier choisi par l'utilisateur pendant l'écriture, gardé */
    function previewAfterAiTurn(names, chosen) {
        state.previewNav = null;
        const written = names.filter(n => state.files[n] != null);
        const target = previewTarget();
        if (!target) {
            const shown = written.find(isHtmlFile) || written.find(isPreviewable) ||
                written.filter(isPageAsset).map(n => pagesUsing(n)[0]).find(Boolean);
            if (shown) state.selectedFile = shown;
        } else if (!chosen && !isHtmlFile(target)) {
            // La sélection suit l'écriture jusqu'au dernier fichier (logo.svg) : une page écrite passe avant
            const page = written.includes(state.entrypoint) && isHtmlFile(state.entrypoint) ? state.entrypoint : written.find(isHtmlFile);
            if (page) state.selectedFile = page;
        }
        if (!previewTarget()) return false;
        if (isPreviewable(state.selectedFile)) state.previewCurrentFile = null;
        state.previewDirty = true;
        state.activeTab = 'preview';
        return true;
    }

    function buildPreviewHtml() {
        const target = previewTarget();
        if (!target) {
            return '<html><body><p style="font-family:sans-serif;padding:20px">Rien à prévisualiser.</p></body></html>';
        }
        state.previewCurrentFile = target;
        // Ancre à atteindre (lien « page.html#section »), une seule fois
        const hash = state.previewHash || '';
        state.previewHash = '';
        const content = state.files[target];
        switch (previewKind(target)) {
            case 'document':
                return isMarkdownFile(target) ? buildMarkdownHtml(content, target, hash) : buildTextHtml(content, target);
            case 'image': return buildImageHtml(content, target, content == null ? fileDataUrl(target) : '');
            case 'table': return buildTableHtml(content, target);
            default: return inlineAssets(content, target, hash);
        }
    }

    /* Affichée comme image : ses éventuels scripts ne s'exécutent pas */
    function buildImageHtml(svg, page, dataUrl) {
        const dark = isDarkTheme();
        const css = `
            html, body { height: 100%; }
            body { max-width: none; padding: 24px; box-sizing: border-box; display: flex; align-items: center; justify-content: center;
                   background: repeating-conic-gradient(${dark ? '#262626' : '#f2f2f2'} 0% 25%, ${dark ? '#1e1e1e' : '#fff'} 0% 50%) 50% / 16px 16px; }
            img { display: block; width: min(100%, 640px); max-height: 100%; object-fit: contain; }`;
        const src = dataUrl || 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        return documentHtml(`<img src="${src}" alt="${escapeHtml(page)}">`, page, '', css);
    }

    /* Séparateur deviné sur la 1re ligne (« ; », « , » ou tabulation ; tabulation pour un .tsv) */
    function parseCsv(text, tsv) {
        let sep = '\t';
        if (!tsv) {
            const counts = { ';': 0, ',': 0, '\t': 0 };
            let quoted = false;
            for (const ch of text.split(/\r?\n/, 1)[0] || '') {
                if (ch === '"') quoted = !quoted;
                else if (!quoted && ch in counts) counts[ch]++;
            }
            sep = Object.keys(counts).reduce((a, b) => counts[b] > counts[a] ? b : a, ',');
        }
        const rows = [];
        let row = [], field = '', quoted = false;
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (quoted) {
                if (c !== '"') field += c;
                else if (text[i + 1] === '"') { field += '"'; i++; }
                else quoted = false;
            } else if (c === '"' && field === '') quoted = true;
            else if (c === sep) { row.push(field); field = ''; }
            else if (c === '\n' || c === '\r') {
                if (c === '\r' && text[i + 1] === '\n') i++;
                row.push(field);
                rows.push(row);
                row = [];
                field = '';
            } else field += c;
        }
        if (field !== '' || row.length) { row.push(field); rows.push(row); }
        return rows.filter(r => r.some(cell => cell.trim() !== ''));
    }

    function buildTableHtml(text, page) {
        const MAX_ROWS = 1000;
        const rows = parseCsv(text, /\.tsv$/i.test(page));
        if (!rows.length) return documentHtml('<p>Ce tableau est vide.</p>', page);
        const shown = rows.slice(0, MAX_ROWS + 1);
        const cols = Math.max(...shown.map(r => r.length));
        const numeric = /^\s*[-+]?(?:\d[\d\s\u00a0]*)(?:[.,]\d+)?\s*%?\s*$/;
        const numCols = Array.from({ length: cols }, (_, i) => {
            const values = shown.slice(1).map(r => (r[i] || '').trim()).filter(Boolean);
            return values.length > 0 && values.every(v => numeric.test(v));
        });
        const cell = (tag, value, i) => `<${tag}${numCols[i] ? ' class="num"' : ''}>${escapeHtml(value)}</${tag}>`;
        const line = (r, tag) => '<tr>' + Array.from({ length: cols }, (_, i) => cell(tag, r[i] || '', i)).join('') + '</tr>';
        const head = '<thead>' + line(shown[0], 'th') + '</thead>';
        const body = '<tbody>' + shown.slice(1).map(r => line(r, 'td')).join('') + '</tbody>';
        const rest = rows.length - shown.length;
        const note = rest > 0 ? `<p class="note">… et ${rest.toLocaleString('fr-FR')} lignes de plus (voir l'onglet Code).</p>` : '';
        const dark = isDarkTheme();
        const css = `
            body { max-width: none; padding: 20px 24px; }
            table { border-collapse: separate; border-spacing: 0; font-size: 14px; line-height: 1.4; }
            th, td { padding: 6px 12px; border: 0; border-bottom: 1px solid ${dark ? '#333' : '#e6e6e6'}; white-space: nowrap; text-align: left; }
            th { position: sticky; top: 0; background: ${dark ? '#262626' : '#f6f6f6'}; font-weight: 600; border-bottom-color: ${dark ? '#444' : '#d9d9d9'}; }
            tbody tr:nth-child(even) td { background: ${dark ? '#222' : '#fafafa'}; }
            .num { text-align: right; font-variant-numeric: tabular-nums; }
            .note { margin-top: 12px; color: ${dark ? '#999' : '#777'}; font-size: 13px; }`;
        return documentHtml(`<table>${head}${body}</table>${note}`, page, '', css);
    }

    /* breaks: true : un saut de ligne simple reste un saut de ligne, comme dans l'onglet Code */
    function buildMarkdownHtml(md, page, hash) {
        let body;
        if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
            body = DOMPurify.sanitize(marked.parse(md, { breaks: true }));
        } else {
            body = '<pre>' + escapeHtml(md) + '</pre>';
        }
        return documentHtml(body, page, hash);
    }

    function buildTextHtml(text, page) {
        return documentHtml('<div style="white-space: pre-wrap">' + escapeHtml(text) + '</div>', page);
    }

    function isDarkTheme() {
        return document.body.classList.contains('dark') ||
            (document.body.classList.contains('theme-auto') && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }

    function documentHtml(body, page, hash, extraCss) {
        const dark = isDarkTheme();
        const css = `
            :root { color-scheme: ${dark ? 'dark' : 'light'}; }
            body { margin: 0; padding: 32px 40px; font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                   color: ${dark ? '#e6e6e6' : '#222'}; background: ${dark ? '#1e1e1e' : '#fff'}; max-width: 780px; }
            h1, h2, h3, h4 { line-height: 1.25; margin: 1.4em 0 0.5em; }
            h1 { font-size: 1.9em; margin-top: 0; } h2 { font-size: 1.45em; } h3 { font-size: 1.2em; }
            p, ul, ol, blockquote, table, pre { margin: 0 0 1em; }
            a { color: ${dark ? '#7ab7ff' : '#0b62c4'}; }
            blockquote { border-left: 4px solid ${dark ? '#444' : '#ddd'}; padding: 0 1em; color: ${dark ? '#aaa' : '#555'}; }
            code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.9em; background: ${dark ? '#2b2b2b' : '#f3f3f3'}; padding: 0.1em 0.3em; border-radius: 4px; }
            pre { background: ${dark ? '#2b2b2b' : '#f6f6f6'}; padding: 12px 14px; border-radius: 6px; overflow-x: auto; }
            pre code { background: none; padding: 0; }
            table { border-collapse: collapse; } th, td { border: 1px solid ${dark ? '#444' : '#ddd'}; padding: 6px 10px; text-align: left; }
            img { max-width: 100%; } hr { border: none; border-top: 1px solid ${dark ? '#444' : '#ddd'}; margin: 2em 0; }`;
        return `<!DOCTYPE html><html><head><meta charset="utf-8">${previewRuntimeTag(page, hash)}<style>${css}${extraCss || ''}</style></head><body>${body}</body></html>`;
    }

    // ---------- Outils de l'aperçu : choisir un élément, changer un texte (voir previewRuntime) ----------

    function postToPreview(msg) {
        const f = dom().previewIframe;
        try { if (f && f.contentWindow) f.contentWindow.postMessage(msg, '*'); } catch (e) { /* page fermée */ }
    }

    function canUsePreviewTools() {
        return state.mode === 'artifacts' && state.activeTab === 'preview' && isPanelOpen() && !!previewTarget()
            && /\.html?$/i.test(previewTarget()) && !state.busy && !state.locked && !state.historyNav && !state.streamingFile;
    }

    function setPreviewTool(tool) {
        tool = tool === 'pick' || tool === 'edit' ? tool : null;
        if (tool && !canUsePreviewTools()) tool = null;
        const was = state.previewTool || null;
        state.previewTool = tool;
        if (tool !== 'pick') hidePickMenu();
        if (!tool) state.picked = null;
        if (tool !== was || !tool) postToPreview({ __davidtwentyaiTool: tool });
        if (tool === 'edit' && was !== 'edit') setEditBanner('Cliquez sur un texte de la page pour le changer. Les liens et les boutons sont inactifs.');
        renderPreviewTools(dom());
    }

    function renderPreviewTools(d) {
        const show = state.mode === 'artifacts' && state.activeTab === 'preview';
        if (state.previewTool && !canUsePreviewTools()) { state.previewTool = null; state.picked = null; hidePickMenu(); postToPreview({ __davidtwentyaiTool: null }); }
        if (d.btnPick) {
            d.btnPick.style.display = show ? '' : 'none';
            d.btnPick.disabled = !state.previewTool && !canUsePreviewTools();
            d.btnPick.classList.toggle('is-active', !!state.previewTool);
            d.btnPick.setAttribute('aria-pressed', state.previewTool ? 'true' : 'false');
            d.btnPick.title = state.previewTool === 'edit' ? 'Terminer la modification des textes'
                : state.previewTool === 'pick' ? 'Arrêter la sélection' : 'Sélectionner un élément de la page';
        }
        if (d.editBanner) d.editBanner.hidden = state.previewTool !== 'edit';
    }

    function setEditBanner(text, tone) {
        const d = dom();
        if (!d.editBannerText) return;
        d.editBannerText.textContent = text;
        d.editBanner.dataset.tone = tone || '';
    }

    function hidePickMenu() {
        const d = dom();
        if (d.pickMenu) {
            // Caché sous la souris : la page ne verrait pas la sortie du menu
            if (!d.pickMenu.hidden) postToPreview({ __davidtwentyaiOverMenu: false });
            d.pickMenu.hidden = true;
        }
    }

    function placePickMenu() {
        const d = dom();
        const info = state.picked;
        if (!d.pickMenu || d.pickMenu.hidden || !info || !d.viewPreview || !d.previewIframe) return;
        const view = d.viewPreview.getBoundingClientRect();
        const fr = d.previewIframe.getBoundingClientRect();
        const r = info.rect || { x: 0, y: 0, w: 0, h: 0 };
        const mw = d.pickMenu.offsetWidth, mh = d.pickMenu.offsetHeight;
        let left = fr.left - view.left + r.x;
        let top = fr.top - view.top + r.y + r.h + 10;
        if (top + mh > view.height - 8) top = fr.top - view.top + r.y - mh - 10;
        d.pickMenu.style.left = Math.round(Math.max(8, Math.min(left, view.width - mw - 8))) + 'px';
        d.pickMenu.style.top = Math.round(Math.max(8, Math.min(top, view.height - mh - 8))) + 'px';
    }

    function showPickMenu(info) {
        const d = dom();
        if (!d.pickMenu) return;
        state.picked = info;
        d.pickLabel.textContent = info.label || '';
        const t = String(info.text || '');
        d.pickText.textContent = t.length > 80 ? t.slice(0, 80) + '…' : t;
        d.pickText.hidden = !t;
        d.pickActions.hidden = false;
        d.pickForm.hidden = true;
        d.pickEditBtn.disabled = !info.leaf;
        d.pickEditBtn.title = info.leaf ? 'Changer ce texte directement dans la page'
            : 'Cet élément contient d\'autres éléments : choisissez un texte plus précis';
        d.pickMenu.hidden = false;
        placePickMenu();
    }

    function openPickAsk() {
        const d = dom();
        if (!state.picked) return;
        d.pickActions.hidden = true;
        d.pickForm.hidden = false;
        d.pickInput.value = '';
        placePickMenu();
        d.pickInput.focus();
    }

    function sendPickAsk() {
        const d = dom();
        const info = state.picked;
        const text = d.pickInput.value.trim();
        if (!info || !text || typeof window.sendArtifactAsk !== 'function') return;
        const page = state.previewCurrentFile || previewTarget();
        const focus = { page, path: info.path || '', label: info.label || '', html: String(info.html || '').slice(0, 2000), text: String(info.text || '').slice(0, 400) };
        if (window.sendArtifactAsk(text, focus)) setPreviewTool(null);
    }

    /* Hors balises, commentaires, scripts, styles, titre et zones de saisie */
    function htmlTextRanges(src) {
        const out = [];
        const re = /<!--[\s\S]*?-->|<(script|style|textarea|title)\b[^>]*>[\s\S]*?<\/\1\s*>|<[^>]*>/gi;
        let last = 0, m;
        while ((m = re.exec(src))) {
            if (m.index > last) out.push({ start: last, end: m.index });
            last = re.lastIndex;
        }
        if (last < src.length) out.push({ start: last, end: src.length });
        return out;
    }

    function decodeHtmlText(s) {
        if (s.indexOf('&') < 0) return s;
        const ta = document.createElement('textarea');
        ta.innerHTML = s;
        return ta.value;
    }

    const normSpaces = t => String(t || '').replace(/\s+/g, ' ').trim();
    const escapeHtmlText = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    /* ordinal / count : rang de l'élément parmi ceux de même texte dans la page affichée */
    function applyPreviewTextEdit(data) {
        const page = state.previewCurrentFile || previewTarget();
        const fail = why => {
            setEditBanner('Texte non enregistré : ' + why + '. Demandez plutôt à l\'IA.', 'error');
            state.previewDirty = true;
            refreshPreview();
        };
        if (!page || typeof state.files[page] !== 'string') return fail('la page est introuvable dans les Artifacts');
        if (readOnlyReason(page)) return fail('les fichiers sont en lecture seule pour le moment');
        if (typeof data.old !== 'string' || typeof data.text !== 'string') return;
        const src = state.files[page];
        const cands = htmlTextRanges(src).filter(r => normSpaces(decodeHtmlText(src.slice(r.start, r.end))) === data.old);
        let r = null;
        if (cands.length === data.count && data.ordinal >= 0) r = cands[data.ordinal];
        else if (cands.length === 1) r = cands[0];
        if (!r) return fail(cands.length ? 'ce texte apparaît plusieurs fois dans la page'
            : 'ce texte n\'est pas écrit tel quel dans la page (créé par un script, ou sur plusieurs lignes)');
        const raw = src.slice(r.start, r.end);
        const lead = /^\s*/.exec(raw)[0], trail = /\s*$/.exec(raw)[0];
        if (state.historyNav) closeHistoryNav(true);
        state.files[page] = src.slice(0, r.start) + lead + escapeHtmlText(data.text) + trail + src.slice(r.end);
        state._timeline = null;
        // La page affichée montre déjà le nouveau texte : pas d'actualisation
        state.previewDirty = false;
        schedulePersist();
        render();
        notifyStateChange();
        setEditBanner(`Texte enregistré dans ${page}. Cliquez sur un autre texte, ou terminez.`, 'ok');
    }

    function showPreviewOf(page) {
        if (state.mode !== 'artifacts') return;
        if (page && fileExists(page) && page !== state.selectedFile) {
            state.selectedFile = page;
            state.previewNav = null;
            state.previewDirty = true;
        }
        setTab('preview');
    }

    // Iframe sandbox sans allow-same-origin : localStorage remplacé, console et liens relayés à DavidTwentyAI
    // Pas de commentaire « // » ici : le script est injecté sur une seule ligne
    function previewRuntime(opts) {
        function memoryStorage() {
            var data = {};
            return {
                getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
                setItem: function (k, v) { data[String(k)] = String(v); },
                removeItem: function (k) { delete data[String(k)]; },
                clear: function () { data = {}; },
                key: function (i) { return Object.keys(data)[i] || null; },
                get length() { return Object.keys(data).length; }
            };
        }
        ['localStorage', 'sessionStorage'].forEach(function (name) {
            try { window[name].getItem('x'); } catch (e) {
                try { Object.defineProperty(window, name, { value: memoryStorage(), configurable: true }); } catch (e2) { /* tant pis */ }
            }
        });

        /* Fichiers du projet demandés par la page (fetch, image ajoutée) : DavidTwentyAI les envoie (answerPreviewFile) */
        var waiting = {}, asked = 0;
        function askFile(path) {
            return new Promise(function (resolve) {
                var id = ++asked;
                waiting[id] = resolve;
                try { parent.postMessage({ __davidtwentyaiFile: true, id: id, path: path }, '*'); } catch (e) { delete waiting[id]; resolve(null); return; }
                setTimeout(function () { if (waiting[id]) { delete waiting[id]; resolve(null); } }, 15000);
            });
        }
        window.addEventListener('message', function (e) {
            var d = e.data;
            if (e.source !== parent || !d || d.__davidtwentyaiFileData !== true || !waiting[d.id]) return;
            var done = waiting[d.id];
            delete waiting[d.id];
            done(d.ok ? d : null);
        });
        function isLocal(u) { return typeof u === 'string' && /\S/.test(u) && !/^\s*(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u); }
        if (window.fetch) {
            var nativeFetch = window.fetch;
            window.fetch = function (input, init) {
                var method = init && init.method ? String(init.method).toUpperCase() : 'GET';
                if (typeof input === 'string' && isLocal(input) && method === 'GET') {
                    return askFile(input).then(function (r) {
                        if (!r) throw new TypeError('Fichier absent des Artifacts : ' + input);
                        return new Response(r.buffer, { status: 200, headers: { 'Content-Type': r.type || 'application/octet-stream' } });
                    });
                }
                return nativeFetch.apply(this, arguments);
            };
        }
        var mediaTags = { IMG: 1, SOURCE: 1, VIDEO: 1, AUDIO: 1, TRACK: 1 };
        function swap(el, attr) {
            var v = el.getAttribute(attr);
            if (!isLocal(v)) return;
            el.__davidtwentyaiWaiting = true;
            askFile(v).then(function (r) {
                if (el.getAttribute(attr) !== v) return;
                el.__davidtwentyaiWaiting = false;
                if (r) el.setAttribute(attr, URL.createObjectURL(new Blob([r.buffer], { type: r.type })));
                else report('error', ['Impossible de charger : ' + v]);
            });
        }
        function swapTree(root) {
            var list = [root].concat(Array.prototype.slice.call(root.querySelectorAll ? root.querySelectorAll('img,source,video,audio,track') : []));
            list.forEach(function (el) {
                if (!mediaTags[el.tagName]) return;
                if (el.hasAttribute('src')) swap(el, 'src');
                if (el.hasAttribute('poster')) swap(el, 'poster');
            });
        }
        new MutationObserver(function (records) {
            records.forEach(function (rec) {
                if (rec.type === 'attributes') { if (mediaTags[rec.target.tagName]) swap(rec.target, rec.attributeName); return; }
                for (var i = 0; i < rec.addedNodes.length; i++) if (rec.addedNodes[i].nodeType === 1) swapTree(rec.addedNodes[i]);
            });
        }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'poster'] });

        /* Console */
        var sent = 0;
        /* « davidtwentyai-canvas/page.html@10:6:16 » (ligne 6 du script en ligne 10) devient « page.html:15:16 » */
        function cleanStack(stack) {
            return stack.replace(/davidtwentyai-canvas\/([^\s:()@]+)(?:@(\d+))?:(\d+)/g, function (all, name, base, line) {
                return name + ':' + (base ? Number(base) + Number(line) - 1 : line);
            });
        }
        function describe(v) {
            try {
                if (typeof v === 'string') return v;
                if (v instanceof Error) return v.stack && v.stack.indexOf(v.message) >= 0 ? cleanStack(v.stack) : v.name + ': ' + v.message;
                if (v === undefined) return 'undefined';
                if (typeof v === 'function') return 'ƒ ' + (v.name || '') + '()';
                if (v && v.nodeType === 1) return '<' + v.tagName.toLowerCase() + (v.id ? '#' + v.id : '') + '>';
                var json = JSON.stringify(v);
                return json === undefined ? String(v) : json;
            } catch (e) { return String(v); }
        }
        var seen = {}, repeats = {}, repeatTimer = 0;
        function postConsole(level, text, where, count) {
            try { parent.postMessage({ __davidtwentyaiConsole: true, level: level, text: text, where: where, count: count }, '*'); } catch (e) { /* rien */ }
        }
        /* Message déjà envoyé : compté, puis envoyé par paquet (une erreur à chaque image n'arrête pas la console) */
        function flushRepeats() {
            repeatTimer = 0;
            var list = repeats;
            repeats = {};
            for (var k in list) postConsole(list[k].level, list[k].text, list[k].where, list[k].count);
        }
        function report(level, args, where) {
            var text = Array.prototype.map.call(args, describe).join(' ');
            if (text.length > 2000) text = text.slice(0, 2000) + '…';
            where = where || '';
            var key = level + '|' + where + '|' + text;
            if (seen[key]) {
                var r = repeats[key] || (repeats[key] = { level: level, text: text, where: where, count: 0 });
                r.count++;
                if (!repeatTimer) repeatTimer = setTimeout(flushRepeats, 500);
                return;
            }
            if (++sent > 500) return;
            seen[key] = 1;
            postConsole(level, text, where, 1);
        }
        /* preview.html : lignes par script (sourceURL « page@ligne ») ; srcdoc : table opts.map */
        function locate(url, line) {
            if (!line) return '';
            var i = (url || '').indexOf('davidtwentyai-canvas/');
            if (location.protocol !== 'about:' && i >= 0) {
                var name = url.slice(i + 12), at = name.lastIndexOf('@');
                return at > 0 ? name.slice(0, at) + ':' + (Number(name.slice(at + 1)) + line - 1) : name + ':' + line;
            }
            var seg = null;
            for (var k = 0; k < opts.map.length && opts.map[k][0] <= line; k++) seg = opts.map[k];
            return seg ? seg[1] + ':' + (seg[2] + line - seg[0]) : opts.page + ':' + line;
        }
        ['log', 'info', 'warn', 'error', 'debug'].forEach(function (method) {
            var original = console[method];
            console[method] = function () {
                report(method === 'debug' ? 'log' : method, arguments);
                if (original) return original.apply(console, arguments);
            };
        });
        window.addEventListener('error', function (e) {
            var t = e.target;
            if (t && t !== window && t.tagName) {
                /* Fichier en cours d'envoi par DavidTwentyAI (swap) ou image sans adresse remplie plus tard : pas d'erreur */
                var url = t.getAttribute('src') || t.getAttribute('href') || t.getAttribute('srcset') || '';
                if (t.__davidtwentyaiWaiting || !/\S/.test(url)) return;
                report('error', ['Impossible de charger : ' + url]);
                return;
            }
            report('error', [e.error || e.message], locate(e.filename, e.lineno));
        }, true);
        window.addEventListener('unhandledrejection', function (e) {
            report('error', ['Promesse rejetée :', e.reason]);
        });

        /* Navigation */
        var external = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
        function send(href) {
            try { parent.postMessage({ __canvasNav: true, href: href }, '*'); } catch (e) { /* rien */ }
        }
        function goToAnchor(raw, instant) {
            var id = raw;
            try { id = decodeURIComponent(raw); } catch (e) { /* tel quel */ }
            var el = id ? document.getElementById(id) || document.getElementsByName(id)[0] : null;
            if (instant && el) el.scrollIntoView({ behavior: 'instant' });
            /* L'adresse change (hashchange, :target) ; le défilement est fait ici, au cas où le navigateur refuse ce changement dans l'aperçu isolé */
            if (location.hash.slice(1) !== raw) { try { location.hash = raw; } catch (e) { /* défilement quand même */ } }
            if (instant) return;
            if (el) el.scrollIntoView();
            else if (!id || id.toLowerCase() === 'top') window.scrollTo(0, 0);
        }
        function samePage(path) {
            var name = opts.page.split('/').pop();
            return !path || path === opts.page || path === name || path === './' + name;
        }
        window.addEventListener('click', function (e) {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
            if (!a || (a.target && a.target !== '_self')) return;
            var href = a.getAttribute('href');
            var hashAt = href.indexOf('#');
            if (hashAt >= 0 && samePage(href.slice(0, hashAt))) {
                e.preventDefault();
                goToAnchor(href.slice(hashAt + 1));
                return;
            }
            if (/^(?:https?:)?\/\//i.test(href)) {
                e.preventDefault();
                window.open(a.href, '_blank', 'noopener');
                return;
            }
            if (external.test(href)) return;
            e.preventDefault();
            send(href);
        });
        document.addEventListener('submit', function (e) {
            var form = e.target;
            var sub = e.submitter && e.submitter.getAttribute ? e.submitter : null;
            var method = ((sub && sub.getAttribute('formmethod')) || (form && form.getAttribute ? form.getAttribute('method') : '') || '').toLowerCase();
            if (method === 'dialog') return;
            var action = (sub && sub.getAttribute('formaction')) || (form && form.getAttribute ? form.getAttribute('action') || '' : '');
            if (e.defaultPrevented || external.test(action)) return;
            e.preventDefault();
            /* Sans action (ou « # ») : la page reste, sinon l'aperçu deviendrait blanc */
            if (action && action.charAt(0) !== '#') send(action);
        });
        if (opts.hash) {
            document.addEventListener('DOMContentLoaded', function () { goToAnchor(opts.hash, true); });
        }

        /* Outils de DavidTwentyAI : « pick » = choisir un élément, « edit » = changer les textes à la main */
        var tool = null, box = null, tag = null, picked = null, editing = null;
        function post(msg) { try { parent.postMessage(msg, '*'); } catch (e) { /* rien */ } }
        function norm(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }
        function labelOf(el) {
            var c = (el.getAttribute('class') || '').trim().split(/\s+/).filter(function (x) { return x && x.indexOf('davidtwentyai') < 0; }).slice(0, 2);
            return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (c.length ? '.' + c.join('.') : '');
        }
        function pathOf(el) {
            var parts = [];
            while (el && el.nodeType === 1 && el !== document.documentElement) {
                var p = el.tagName.toLowerCase();
                if (el.id) { parts.unshift(p + '#' + el.id); break; }
                var i = 1, sib = el;
                while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) i++;
                parts.unshift(p + (i > 1 ? ':nth-of-type(' + i + ')' : ''));
                el = el.parentElement;
            }
            return parts.join(' > ');
        }
        function isLeaf(el) {
            if (!el || /^(SCRIPT|STYLE|SVG|IMG|INPUT|TEXTAREA|SELECT|VIDEO|AUDIO|CANVAS|IFRAME)$/i.test(el.tagName)) return false;
            for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && !/^(BR|WBR)$/.test(n.tagName)) return false;
            return /\S/.test(el.textContent);
        }
        function ensureBox() {
            if (box) return;
            box = document.createElement('div');
            box.setAttribute('data-davidtwentyai-ui', '');
            box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #F06D13;border-radius:5px;background:rgba(240,109,19,.07);display:none;box-sizing:border-box';
            tag = document.createElement('div');
            tag.style.cssText = 'position:absolute;left:-2px;top:-24px;background:#F06D13;color:#fff;font:600 11px/20px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;padding:0 7px;border-radius:5px;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis';
            box.appendChild(tag);
            document.documentElement.appendChild(box);
        }
        function frame(el, dashed) {
            ensureBox();
            if (!el) { box.style.display = 'none'; return; }
            var r = el.getBoundingClientRect();
            box.style.display = 'block';
            box.style.borderStyle = dashed ? 'dashed' : 'solid';
            box.style.left = (r.left - 3) + 'px';
            box.style.top = (r.top - 3) + 'px';
            box.style.width = (r.width + 6) + 'px';
            box.style.height = (r.height + 6) + 'px';
            tag.textContent = labelOf(el);
            tag.style.display = dashed ? 'none' : '';
            tag.style.top = r.top < 26 ? (r.height + 8) + 'px' : '-24px';
        }
        function targetOf(e) {
            var el = e.target;
            if (!el || el.nodeType !== 1 || el === document.documentElement || el === document.body || el.closest('[data-davidtwentyai-ui]')) return null;
            return el;
        }
        function startEdit(el) {
            stopEdit(true);
            if (!el) return;
            if (!isLeaf(el)) { post({ __davidtwentyaiEditRefused: true, label: labelOf(el) }); return; }
            editing = el;
            el.__davidtwentyaiOld = el.textContent;
            /* Styles de la page rendus à la fin (le contour suit ses arrondis) */
            el.__davidtwentyaiStyle = { outline: el.style.outline, outlineOffset: el.style.outlineOffset };
            el.setAttribute('contenteditable', 'plaintext-only');
            if (el.contentEditable !== 'plaintext-only') el.setAttribute('contenteditable', 'true');
            el.style.outline = '2px solid #F06D13';
            el.style.outlineOffset = '3px';
            frame(null);
            el.focus();
            try { var range = document.createRange(); range.selectNodeContents(el); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); } catch (e) { /* rien */ }
            post({ __davidtwentyaiEditing: true, label: labelOf(el) });
        }
        function stopEdit(save) {
            var el = editing;
            if (!el) return;
            editing = null;
            el.removeAttribute('contenteditable');
            var st = el.__davidtwentyaiStyle || {};
            el.style.outline = st.outline || '';
            el.style.outlineOffset = st.outlineOffset || '';
            if (!el.getAttribute('style')) el.removeAttribute('style');
            var old = el.__davidtwentyaiOld, now = el.textContent;
            if (!save) { el.textContent = old; return; }
            if (norm(now) === norm(old)) return;
            /* Rang parmi les éléments au même texte, dans l'ordre de la page */
            var same = [], all = document.body ? document.body.getElementsByTagName('*') : [];
            for (var i = 0; i < all.length; i++) {
                var x = all[i];
                if (x === el || (isLeaf(x) && norm(x.textContent) === norm(old))) same.push(x);
            }
            post({ __davidtwentyaiTextEdit: true, old: norm(old), text: norm(now), ordinal: same.indexOf(el), count: same.length, label: labelOf(el) });
        }
        /* DavidTwentyAI redit overMenu à chaque mouvement sur son menu : un mousemove reçu ici veut dire qu'on l'a quitté */
        var overMenu = false;
        function holding() { return overMenu && tool === 'pick' && picked && picked.isConnected; }
        window.addEventListener('mousemove', function (e) {
            if (!tool || editing) return;
            overMenu = false;
            var el = targetOf(e);
            if (tool === 'pick') frame(el);
            else frame(el && isLeaf(el) ? el : null, true);
            document.documentElement.style.cursor = tool === 'pick' ? 'crosshair' : (el && isLeaf(el) ? 'text' : 'default');
        }, true);
        window.addEventListener('mouseleave', function () { if (tool && !editing && !overMenu) frame(null); });
        window.addEventListener('scroll', function () { if (holding()) frame(picked); }, true);
        window.addEventListener('click', function (e) {
            if (!tool) return;
            /* Outil actif : aucun clic n'arrive à la page, même dans le texte en cours de modification */
            e.preventDefault();
            e.stopImmediatePropagation();
            if (editing && editing.contains(e.target)) return;
            var el = targetOf(e);
            /* En modification, un clic ailleurs revient au menu de choix plutôt que modifier n'importe quel texte */
            if (tool === 'edit') {
                stopEdit(true);
                tool = 'pick';
                document.documentElement.style.cursor = 'crosshair';
                post({ __davidtwentyaiToolChanged: 'pick' });
            }
            if (tool === 'pick') {
                if (!el) return;
                picked = el;
                frame(el);
                var r = el.getBoundingClientRect();
                post({ __davidtwentyaiPicked: true, label: labelOf(el), path: pathOf(el), html: el.outerHTML.replace(/(?:data|blob):[^"')\s]{40,}/g, '…').slice(0, 2000), text: norm(el.innerText || el.textContent).slice(0, 400), leaf: isLeaf(el), rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
                return;
            }
            startEdit(el);
        }, true);
        /* Outil actif : la page ne reçoit rien ; en modification, le pointeur garde son effet par défaut */
        ['submit', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'auxclick', 'dblclick', 'contextmenu'].forEach(function (type) {
            window.addEventListener(type, function (e) {
                if (!tool) return;
                e.stopImmediatePropagation();
                if (tool === 'edit' && type !== 'submit' && type !== 'auxclick') return;
                /* Toucher : le clic qui suit choisit (écouteurs passifs) ; clic droit : menu du navigateur gardé */
                if (type === 'touchstart' || type === 'touchend' || type === 'contextmenu') return;
                if (e.cancelable) e.preventDefault();
            }, true);
        });
        /* Outil actif : touches gardées à DavidTwentyAI ; Échap lui est transmis, la page ayant le clavier */
        window.addEventListener('keydown', function (e) {
            if (!tool) return;
            e.stopImmediatePropagation();
            if (!editing) {
                if (e.key === 'Escape') { e.preventDefault(); post({ __davidtwentyaiEscape: true }); }
                return;
            }
            if (e.key === 'Escape') { e.preventDefault(); stopEdit(false); }
            else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); editing.blur(); }
            else if (e.key === ' ' && !e.isComposing && !e.ctrlKey && !e.metaKey && !e.altKey) {
                /* Espace écrite à la main : dans un bouton, le navigateur la garde pour le déclencher */
                e.preventDefault();
                try { document.execCommand('insertText', false, ' '); } catch (err) { /* rien */ }
            }
        }, true);
        ['keyup', 'keypress'].forEach(function (type) {
            window.addEventListener(type, function (e) {
                if (!tool) return;
                e.stopImmediatePropagation();
                if (type === 'keyup' && e.key === ' ' && editing) e.preventDefault();
            }, true);
        });
        ['beforeinput', 'input'].forEach(function (type) {
            window.addEventListener(type, function (e) {
                if (editing && editing.contains(e.target)) e.stopImmediatePropagation();
            }, true);
        });
        document.addEventListener('focusout', function (e) { if (editing && e.target === editing) stopEdit(true); }, true);
        window.addEventListener('message', function (e) {
            var d = e.data;
            if (e.source !== parent || !d || typeof d !== 'object') return;
            if (d.__davidtwentyaiTool !== undefined) {
                if (tool && d.__davidtwentyaiTool !== tool) stopEdit(true);
                tool = d.__davidtwentyaiTool || null;
                frame(tool === 'pick' && picked && picked.isConnected ? picked : null);
                if (!tool) picked = null;
                document.documentElement.style.cursor = tool === 'pick' ? 'crosshair' : '';
            }
            if (d.__davidtwentyaiEditPicked === true && picked && picked.isConnected) { tool = 'edit'; startEdit(picked); }
            if (d.__davidtwentyaiUnpick === true) { picked = null; frame(null); }
            if (d.__davidtwentyaiOverMenu !== undefined) {
                overMenu = !!d.__davidtwentyaiOverMenu;
                if (overMenu && tool === 'pick' && !editing) frame(holding() ? picked : null);
            }
        });

        /* Même position qu'avant l'actualisation, puis suivie pour la suivante */
        function restoreScroll() {
            if (!opts.scroll) return;
            try { window.scrollTo({ left: opts.scroll.x, top: opts.scroll.y, behavior: 'instant' }); } catch (e) { window.scrollTo(opts.scroll.x, opts.scroll.y); }
        }
        if (opts.scroll) document.addEventListener('DOMContentLoaded', restoreScroll);
        var scrollTimer = 0;
        window.addEventListener('scroll', function () {
            if (scrollTimer) return;
            scrollTimer = setTimeout(function () {
                scrollTimer = 0;
                try { parent.postMessage({ __davidtwentyaiScroll: true, x: window.scrollX, y: window.scrollY }, '*'); } catch (e) { /* rien */ }
            }, 150);
        }, { passive: true });

        /* Page chargée (images, polices…) : DavidTwentyAI la montre à la place de l'ancienne */
        window.addEventListener('load', function () {
            restoreScroll();
            try { parent.postMessage({ __davidtwentyaiPreviewLoaded: true }, '*'); } catch (e) { /* rien */ }
        });
    }

    function previewRuntimeTag(page, hash, map) {
        // Même page actualisée, sans ancre à atteindre : même défilement
        const sc = state.previewScroll;
        const scroll = !hash && sc && sc.page === page && (sc.x || sc.y) ? { x: sc.x, y: sc.y } : null;
        const opts = JSON.stringify({ page: page || '', hash: hash || '', map: map || [], scroll }).replace(/</g, '\\u003c');
        const code = previewRuntime.toString().replace(/\s*\n\s*/g, ' ');
        return '<script>(' + code + ')(' + opts + ');<\/script>';
    }

    /** Script JavaScript (pas un modèle, ni des données JSON…). */
    function isJsScript(attrs) {
        const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs || '');
        return !type || /^(?:module|(?:text|application)\/(?:java|ecma)script)$/i.test(type[1]);
    }

    /* map : [ligne produite, fichier, ligne d'origine], et sourceURL par script, pour situer les erreurs */
    function inlineAssets(html, from, hash) {
        // Images, médias et url() en data:, sans retour à la ligne : la ligne de chaque balise ne change pas
        html = rewritePageRefs(html, from);
        const re = /<link\b[^>]*\bhref="([^"]+)"[^>]*>|<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
        const isRemote = (url) => /^(https?:|data:|\/\/)/i.test(url);
        const countLines = (str) => (str.match(/\n/g) || []).length;
        const map = [[1, from, 1]];
        let out = '', last = 0, outLine = 1, srcLine = 1, m;
        const emit = (str) => { out += str; outLine += countLines(str); };
        // defer ne vaut que pour un fichier : son code inséré est mis en fin de <body>, dans l'ordre
        const DEFER_RE = /(?:^|\s)defer(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?(?=\s|$)/i;
        const deferred = [];
        while ((m = re.exec(html))) {
            const before = html.slice(last, m.index);
            emit(before);
            srcLine += countLines(before);
            const tag = m[0];
            let replacement = null;
            if (m[1] !== undefined) {
                // Feuille du canvas seulement (pas une icône, un manifeste…)
                const resolved = isRemote(m[1]) ? null : resolvePath(m[1], from);
                const css = resolved && /\.css$/i.test(resolved) ? fileText(resolved) : null;
                if (css != null) {
                    // Ses attributs (id, media…) restent : un script peut chercher la feuille
                    replacement = '<style' + styleAttrsFromLink(tag) + '>\n' + rewriteCss(css, resolved).replace(/<\/style/gi, '<\\/style') + '\n</style>';
                }
            } else {
                const attrs = m[2] || '';
                const src = /\bsrc\s*=\s*"([^"]+)"/i.exec(attrs);
                const deferredHere = DEFER_RE.test(attrs) && !/\btype\s*=\s*["']?module/i.test(attrs);
                if (src && isRemote(src[1]) && deferredHere && !/(?:^|\s)async(?=[\s=]|$)/i.test(attrs)) {
                    deferred.push({ resolved: null, script: '<script' + attrs.replace(DEFER_RE, '') + '></script>' });
                    replacement = '';
                } else if (src) {
                    // Code inséré sur la ligne de la balise ; un « </script> » dans le code fermerait la balise trop tôt
                    const resolved = isRemote(src[1]) ? null : resolvePath(src[1], from);
                    const code = resolved ? fileText(resolved) : null;
                    if (code != null) {
                        const isDeferred = deferredHere;
                        const script = '<script' + attrs.replace(/\s*\bsrc\s*=\s*"[^"]*"/i, '').replace(DEFER_RE, '') + '>' +
                            code.replace(/<\/script/gi, '<\\/script') +
                            '\n//# sourceURL=davidtwentyai-canvas/' + resolved + '\n</script>';
                        if (isDeferred) {
                            deferred.push({ resolved, script });
                            replacement = '';
                        } else {
                            map.push([outLine, resolved, 1]);
                            replacement = script;
                        }
                    }
                } else if (isJsScript(attrs)) {
                    // Script de la page : son nom indique la ligne de sa balise
                    replacement = '<script' + attrs + '>' + m[3] +
                        '\n//# sourceURL=davidtwentyai-canvas/' + from + '@' + srcLine + '\n</script>';
                }
            }
            emit(replacement === null ? tag : replacement);
            srcLine += countLines(tag);
            // La suite de la page reprend sur la dernière ligne de la balise d'origine
            if (replacement !== null) map.push([outLine, from, srcLine]);
            last = m.index + tag.length;
        }
        const tail = html.slice(last);
        if (deferred.length) {
            // Avant le dernier </body> (sinon à la fin de la page)
            const close = [...tail.matchAll(/<\/body\s*>/gi)].pop();
            const cut = close ? close.index : tail.length;
            const before = tail.slice(0, cut);
            emit(before);
            srcLine += countLines(before);
            for (const d of deferred) {
                if (d.resolved) map.push([outLine, d.resolved, 1]);
                emit(d.script);
            }
            map.push([outLine, from, srcLine]);
            emit(tail.slice(cut));
        } else emit(tail);
        // Le script d'aperçu, sur la ligne de <head> : il ne décale aucune ligne
        const runtime = previewRuntimeTag(from, hash, map);
        if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (h) => h + runtime);
        else out = runtime + out;
        return out;
    }

    /* Les projets importés ont des sous-dossiers : « ../css/style.css » */
    function resolvePath(href, from) {
        let clean = String(href).split('#')[0].split('?')[0];
        try { clean = decodeURIComponent(clean); } catch (e) { /* lien mal encodé : tel quel */ }
        const dir = from && from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
        const full = normalizePath(clean.startsWith('/') ? clean : dir + clean);
        if (full && fileExists(full)) return full;
        // Accents écrits autrement : « é » en un caractère, ou « e » suivi de l'accent (Mac)
        if (full && /[^\x00-\x7f]/.test(full)) {
            const nfc = full.normalize('NFC');
            const same = allFileNames().find(n => n.normalize('NFC') === nfc);
            if (same) return same;
        }
        clean = clean.replace(/^\.\//, '');
        if (fileExists(clean)) return clean;
        // Essayer avec le basename, à la racine puis dans un seul sous-dossier
        const base = clean.split('/').pop();
        if (!base) return null;
        if (fileExists(base)) return base;
        const matches = allFileNames().filter(n => n.split('/').pop().normalize('NFC') === base.normalize('NFC'));
        return matches.length === 1 ? matches[0] : null;
    }

    // ---------- Aperçu sans serveur : fichiers du projet en data:, ou envoyés par DavidTwentyAI (__davidtwentyaiFile) ----------

    const REMOTE_URL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

    function localRef(url, from) {
        const u = String(url || '').trim();
        if (!u || REMOTE_URL_RE.test(u)) return null;
        return resolvePath(u, from);
    }

    /* .env importé : jamais donné à l'aperçu (il a accès à Internet) */
    function isSecretAsset(name) {
        const a = name && state.files[name] == null ? state.assets[name] : null;
        return !!(a && a.why === 'secret');
    }

    /* '' si le fichier n'est pas encore lu */
    function fileDataUrl(name) {
        if (isSecretAsset(name)) return '';
        if (state.files[name] != null) {
            return 'data:' + mimeOf(name) + ';charset=utf-8,' + encodeURIComponent(state.files[name])
                .replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
        }
        const a = state.assets[name];
        return a ? (assetDataUrls.get(a.hash) || '') : '';
    }

    function fileText(name) {
        if (state.files[name] != null) return state.files[name];
        if (isSecretAsset(name)) return null;
        const a = state.assets[name];
        return a && assetTexts.has(a.hash) ? assetTexts.get(a.hash) : null;
    }

    /* Adresse entre guillemets (qui peut contenir l'autre guillemet) ou sans guillemets */
    const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"'()\s]+))\s*\)/gi;
    const CSS_IMPORT_RE = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^"'()\s;]+))\s*\)?([^;]*);/gi;

    function rewriteCss(css, from, depth) {
        depth = depth || 0;
        css = css.replace(CSS_IMPORT_RE, (m, dq, sq, bare, media) => {
            const url = dq != null ? dq : sq != null ? sq : bare;
            const name = depth < 3 ? localRef(url, from) : null;
            const text = name ? fileText(name) : null;
            if (text == null) return m;
            const inner = rewriteCss(text, name, depth + 1);
            return media.trim() ? `@media ${media.trim()} {\n${inner}\n}` : inner;
        });
        return css.replace(CSS_URL_RE, (m, dq, sq, bare) => {
            const name = localRef(dq != null ? dq : sq != null ? sq : bare, from);
            const data = name ? fileDataUrl(name) : '';
            return data ? `url("${data}")` : m;
        });
    }

    function rewritePageRefs(html, from) {
        html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (m, open, css, close) => open + rewriteCss(css, from) + close);
        html = html.replace(/\bstyle\s*=\s*"([^"]*)"/gi, (m, css) => css.indexOf('url(') < 0 ? m
            : 'style="' + rewriteCss(css.replace(/&quot;/g, '"'), from).replace(/"/g, '&quot;') + '"');
        return html.replace(/<(img|source|video|audio|track|embed|object|input|image|use|link)\b([^>]*)>/gi, (tag, el, attrs) => {
            const kind = el.toLowerCase();
            // <link> : icônes, préchargements (les feuilles de style sont insérées plus loin)
            if (kind === 'link' && !/\brel\s*=\s*["']?[^"'>]*\b(?:icon|apple-touch-icon|preload|prefetch|image_src)\b/i.test(attrs)) return tag;
            return tag.replace(/(\s)(src|href|poster|data|xlink:href|srcset)\s*=\s*(["'])([^"']*)\3/gi, (m, sp, attr, q, value) => {
                const a = attr.toLowerCase();
                if (a === 'srcset') {
                    const v = value.split(',').map(part => {
                        const bits = part.trim().split(/\s+/);
                        const name = localRef(bits[0], from);
                        const data = name ? fileDataUrl(name) : '';
                        return (data || bits[0]) + (bits.length > 1 ? ' ' + bits.slice(1).join(' ') : '');
                    }).join(', ');
                    return `${sp}${attr}=${q}${v}${q}`;
                }
                if ((a === 'href' || a === 'xlink:href') && kind !== 'link' && kind !== 'image' && kind !== 'use') return m;
                const name = localRef(value, from);
                const data = name ? fileDataUrl(name) : '';
                return data ? `${sp}${attr}=${q}${data}${q}` : m;
            });
        });
    }

    /* Attributs gardés sur le <style> qui remplace le <link> : un script peut les chercher */
    function styleAttrsFromLink(tag) {
        const keep = [];
        const attrs = tag.replace(/^<link\b/i, '').replace(/\/?>$/, '');
        const re = /\s([a-z][\w:.-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/gi;
        let m;
        while ((m = re.exec(attrs))) {
            if (/^(?:id|class|media|title|nonce)$|^data-/i.test(m[1])) keep.push(m[0]);
        }
        return keep.join('');
    }

    function previewAssetsToLoad(target) {
        if (!hasAssets() || !target) return [];
        const want = new Set();
        const need = (name) => {
            if (name && state.files[name] == null && isAsset(name) && !isSecretAsset(name) && !assetDataUrls.has(state.assets[name].hash)) want.add(name);
        };
        const kind = previewKind(target);
        if (kind === 'image') { need(target); return [...want]; }
        if (kind !== 'page') return [];
        const scanCss = (css, from, depth) => {
            for (const m of css.matchAll(CSS_URL_RE)) need(localRef(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3], from));
            for (const m of css.matchAll(CSS_IMPORT_RE)) {
                const n = localRef(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3], from);
                need(n);
                const t = n ? fileText(n) : null;
                if (t != null && depth < 3) scanCss(t, n, depth + 1);
            }
        };
        const html = fileText(target) || '';
        for (const m of html.matchAll(/\s(?:src|poster|data|xlink:href)\s*=\s*["']([^"']+)["']/gi)) need(localRef(m[1], target));
        for (const m of html.matchAll(/\ssrcset\s*=\s*["']([^"']+)["']/gi)) {
            for (const part of m[1].split(',')) need(localRef(part.trim().split(/\s+/)[0], target));
        }
        for (const m of html.matchAll(/<link\b[^>]*\shref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
            const n = localRef(m[1], target);
            need(n);
            const t = n && /\.css$/i.test(n) ? fileText(n) : null;
            if (t != null) scanCss(t, n, 0);
        }
        scanCss(html, target, 0);
        return [...want];
    }

    async function answerPreviewFile(source, data) {
        const reply = (msg, transfer) => { try { source.postMessage(msg, '*', transfer || []); } catch (e) { /* page fermée */ } };
        const name = typeof data.path === 'string' ? localRef(data.path, state.previewCurrentFile) : null;
        if (!name || isSecretAsset(name)) { reply({ __davidtwentyaiFileData: true, id: data.id, ok: false }); return; }
        let buffer = null;
        if (state.files[name] != null) buffer = new TextEncoder().encode(state.files[name]).buffer;
        else {
            const blob = await assetBlob(state.assets[name].hash);
            if (blob) buffer = await blob.arrayBuffer();
        }
        if (!buffer) { reply({ __davidtwentyaiFileData: true, id: data.id, ok: false }); return; }
        reply({ __davidtwentyaiFileData: true, id: data.id, ok: true, type: (state.assets[name] && state.assets[name].type) || mimeOf(name), buffer }, [buffer]);
    }

    function refreshPreview() {
        const d = dom();
        if (!d.previewIframe) return;
        const target = previewTarget();
        if (d.previewEmpty) {
            d.previewEmpty.style.display = target ? 'none' : '';
            const text = d.previewEmpty.querySelector('p');
            if (text && !target) text.textContent = noPreviewReason();
        }
        if (!target) {
            setPreviewLoading(false);
            blankPreview();
            state.previewDirty = false;
            return;
        }
        // Fichiers non lus d'abord (une feuille de style lue peut en citer d'autres : nouveau tour)
        const missing = previewAssetsToLoad(target);
        if (missing.length) {
            setPreviewLoading(true);
            const seq = state._assetLoadSeq = (state._assetLoadSeq || 0) + 1;
            loadAssetsForPreview(missing).then(() => {
                if (seq !== state._assetLoadSeq || state.activeTab !== 'preview') return;
                refreshPreview();
            });
            return;
        }
        // Une page se charge déjà : on la laisse finir, la suivante partira avec l'état le plus récent
        if (state._backFrame || state._previewSwapping) {
            state._previewQueued = true;
            return;
        }
        const html = buildPreviewHtml();
        resetConsole(state.previewCurrentFile);
        setPreviewLoading(true);
        // Iframe neuve et invisible posée dessus, échangée une fois chargée : pas de page blanche
        const frame = state._backFrame = newBackFrame(d.previewIframe);
        state.previewDirty = false;
        clearTimeout(state._previewFallbackTimer);
        clearTimeout(state._swapTimer);
        state._swapTimer = setTimeout(swapPreviewFrames, PREVIEW_SWAP_MAX_MS);
        state._pendingPreviewHtml = null;
        // Page web par preview.html : un srcdoc hériterait de la CSP de DavidTwentyAI (bibliothèques externes bloquées)
        if (previewKind(state.previewCurrentFile) !== 'page' || state._previewHostOk === false) {
            frame.srcdoc = html;
            return;
        }
        state._pendingPreviewHtml = html;
        state._previewSeq = (state._previewSeq || 0) + 1;
        const seq = state._previewSeq;
        const fallBack = () => {
            if (state._pendingPreviewHtml !== html || state._previewSeq !== seq || !frame.isConnected) return;
            // preview.html déjà vue fonctionner : un chargement lent ne la condamne pas pour la session
            if (state._previewHostOk !== true) state._previewHostOk = false;
            state._pendingPreviewHtml = null;
            frame.removeAttribute('src');
            frame.srcdoc = html;
        };
        state._previewFallbackTimer = setTimeout(fallBack, 2000);
        if (state._previewHostOk === undefined) {
            // preview.html chargée sans signal (bloquée par le navigateur) : secours sans attendre les 2 s
            frame.addEventListener('load', () => setTimeout(fallBack, 400), { once: true });
        }
        frame.src = 'preview.html?v=' + seq;
    }

    // ---------- Aperçu sans clignotement : seconde iframe échangée au chargement ----------

    const PREVIEW_SWAP_MAX_MS = 3000;

    function newBackFrame(front) {
        const frame = document.createElement('iframe');
        frame.className = 'canvas-preview-iframe is-back';
        // Mêmes droits que l'iframe d'index.html ; jamais allow-same-origin (la page lirait les clés)
        frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock allow-downloads allow-popups-to-escape-sandbox');
        frame.setAttribute('allow', 'fullscreen; clipboard-write');
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;
        frame.title = 'Aperçu';
        if (front) front.after(frame);
        else {
            const view = document.getElementById('canvas-preview-view');
            if (view) view.prepend(frame);
        }
        return frame;
    }

    /* L'ancienne est retirée un peu après, le temps que la nouvelle soit peinte */
    function swapPreviewFrames() {
        const back = state._backFrame;
        clearTimeout(state._swapTimer);
        if (!back) return;
        state._backFrame = null;
        if (!back.isConnected) return;
        const d = dom();
        const old = d.previewIframe;
        back.classList.remove('is-back');
        back.removeAttribute('aria-hidden');
        back.removeAttribute('tabindex');
        back.id = 'canvas-preview-iframe';
        d.previewIframe = back;
        // Actualisation demandée entre-temps : une fois l'ancienne retirée
        const next = () => {
            state._previewSwapping = false;
            if (!state._previewQueued) return;
            state._previewQueued = false;
            if (state.activeTab === 'preview' && isPanelOpen()) {
                state.previewDirty = true;
                refreshPreview();
            }
        };
        if (!old || old === back) { next(); return; }
        old.removeAttribute('id');
        old.classList.add('is-leaving');
        state._previewSwapping = true;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            old.remove();
            next();
        };
        requestAnimationFrame(() => requestAnimationFrame(finish));
        // Onglet en arrière-plan (pas d'images dessinées) : retirée quand même
        setTimeout(finish, 150);
    }

    /* about:blank plutôt que srcdoc='' : certains navigateurs ne rechargent pas un srcdoc vidé puis réassigné */
    function blankPreview() {
        clearTimeout(state._swapTimer);
        clearTimeout(state._previewFallbackTimer);
        state._pendingPreviewHtml = null;
        state._previewQueued = false;
        if (state._backFrame) {
            state._backFrame.remove();
            state._backFrame = null;
        }
        const d = dom();
        if (!d.previewIframe) return;
        d.previewIframe.removeAttribute('srcdoc');
        d.previewIframe.src = 'about:blank';
    }

    function previewShowing() {
        const f = dom().previewIframe;
        const src = f && f.getAttribute('src');
        return !!(state._backFrame || (f && (f.hasAttribute('srcdoc') || (src && src !== 'about:blank'))));
    }

    /* Après 120 ms (rien pour une page aussitôt affichée), jusqu'au signal de la page, 15 s au plus */
    function setPreviewLoading(on) {
        const el = dom().previewLoading;
        clearTimeout(state._loadingTimer);
        if (!el) return;
        if (!on) {
            el.hidden = true;
            return;
        }
        state._loadingTimer = setTimeout(() => {
            el.hidden = false;
            state._loadingTimer = setTimeout(() => { el.hidden = true; }, 15000);
        }, 120);
    }

    function onPreviewHostReady(v, source) {
        const html = state._pendingPreviewHtml;
        // Ignorer le signal d'un chargement précédent (actualisations rapides).
        if (html == null || v !== '?v=' + state._previewSeq) return;
        state._pendingPreviewHtml = null;
        state._previewHostOk = true;
        clearTimeout(state._previewFallbackTimer);
        try { source.postMessage({ __davidtwentyaiPreviewHtml: true, html }, '*'); } catch (e) { /* iframe retirée */ }
    }

    // ---------- Console de la page prévisualisée ----------

    const CONSOLE_LABELS = { error: 'Erreur', warn: 'Avertissement', info: 'Info', log: 'Log' };
    const MAX_CONSOLE_ENTRIES = 500;
    const CONSOLE_SUMMARY_LINES = 30;

    function resetConsole(page) {
        state.consoleEntries = [];
        state._consoleIndex = new Map();
        state.consolePage = page || '';
        // Fichiers au chargement de la page : console périmée s'ils ont changé depuis (consoleStale)
        state._consoleSig = page ? filesSignature() : null;
        scheduleConsoleRender();
    }

    function addConsoleEntry(level, text, where, count) {
        if (!CONSOLE_LABELS[level]) level = 'log';
        text = String(text == null ? '' : text);
        where = String(where || '');
        const n = Number.isSafeInteger(count) && count > 0 ? count : 1;
        if (!state._consoleIndex) state._consoleIndex = new Map();
        const key = level + '|' + where + '|' + text;
        const known = state._consoleIndex.get(key);
        if (known) known.count += n;
        else {
            if (state.consoleEntries.length >= MAX_CONSOLE_ENTRIES) return;
            const entry = { level, text, where, count: n };
            state.consoleEntries.push(entry);
            state._consoleIndex.set(key, entry);
        }
        scheduleConsoleRender();
    }

    const consoleCount = (level) => state.consoleEntries.reduce((s, e) => s + (!level || e.level === level ? e.count || 1 : 0), 0);

    function filesSignature() {
        let h = 0x811c9dc5;
        for (const name of Object.keys(state.files).sort()) {
            const s = name + '\u0000' + state.files[name] + '\u0000';
            for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
        }
        return h;
    }

    const consoleStale = () => state._consoleSig != null && state._consoleSig !== filesSignature();

    /* Résumé pour l'IA (bouton et read_console) : erreurs d'abord, répétitions regroupées, longueur bornée */
    function consoleSummaryLines(all) {
        const rank = { error: 0, warn: 1, info: 2, log: 3 };
        const list = state.consoleEntries.filter(e => all || e.level === 'error' || e.level === 'warn')
            .map((e, i) => ({ e, i })).sort((a, b) => rank[a.e.level] - rank[b.e.level] || a.i - b.i).map(x => x.e);
        const kept = list.slice(0, CONSOLE_SUMMARY_LINES);
        const fresh = !consoleStale();
        const lines = kept.map(e => {
            const text = e.text.length > 500 ? e.text.slice(0, 500) + '…' : e.text;
            return `[${CONSOLE_LABELS[e.level]}]${e.count > 1 ? ' ×' + e.count : ''} ${text}${e.where ? ' (' + e.where + (fresh ? sourceLineOf(e.where) : '') + ')' : ''}`;
        });
        if (list.length > kept.length) lines.push(`(${list.length - kept.length} autres messages différents non repris)`);
        return lines;
    }

    /* Texte de la ligne en cause (« script.js:66 ») : un petit modèle ne sait pas compter les lignes */
    function sourceLineOf(where) {
        const m = /^(.+):(\d+)$/.exec(where);
        const src = m && typeof state.files[m[1]] === 'string' ? state.files[m[1]].split('\n')[Number(m[2]) - 1] : null;
        const code = src ? src.trim() : '';
        return code ? ' : ' + (code.length > 160 ? code.slice(0, 160) + '…' : code) : '';
    }

    /* Ligne jointe au message de l'utilisateur (modèles à outils) : s'il y a des erreurs, et la console à jour */
    function consoleNote() {
        if (currentMode() !== 'artifacts' || !state.consolePage || consoleStale()) return '';
        const total = consoleCount('error');
        if (!total) return '';
        const kinds = state.consoleEntries.filter(e => e.level === 'error').length;
        return total === 1 ? '[Console de l\'aperçu : 1 erreur ; read_console pour la lire]'
            : `[Console de l'aperçu : ${total} erreurs${kinds > 1 ? ` (${kinds} différentes)` : ''} ; read_console pour les lire]`;
    }

    /* Réponse de l'outil read_console */
    function consoleForAi(args) {
        if (!state.consolePage) return 'Console vide : aucune page n\'a encore tourné dans l\'aperçu.';
        const all = !!(args && args.all === true);
        const stale = consoleStale() ? 'Attention : messages d\'avant les dernières modifications des fichiers (l\'aperçu n\'a pas été rechargé depuis).\n' : '';
        const head = `${stale}Console de la page « ${state.consolePage} » depuis son dernier chargement`;
        if (!state.consoleEntries.length) return head + ' : aucun message.';
        const lines = consoleSummaryLines(all);
        const others = all ? 0 : state.consoleEntries.filter(e => e.level !== 'error' && e.level !== 'warn').length;
        const more = others ? `\n(${plural(others, 'autre message ordinaire', 'autres messages ordinaires')} : read_console avec all pour les lire)` : '';
        return lines.length ? `${head} :\n${lines.join('\n')}${more}` : `${head} : aucune erreur ni avertissement.${more}`;
    }

    function scheduleConsoleRender() {
        if (state._consoleFrame) return;
        state._consoleFrame = requestAnimationFrame(() => {
            state._consoleFrame = 0;
            renderConsole(dom());
        });
    }

    function setConsoleOpen(open) {
        state.consoleOpen = !!open;
        renderConsole(dom(), true);
    }

    function renderConsole(d, toBottom) {
        const entries = state.consoleEntries;
        const errors = consoleCount('error');
        if (d.consoleBtn) {
            d.consoleBtn.hidden = !entries.length && !Object.keys(state.files).some(isHtmlFile);
            d.consoleBtn.classList.toggle('is-active', state.consoleOpen);
            d.consoleBtn.setAttribute('aria-expanded', String(state.consoleOpen));
            d.consoleBtn.title = errors
                ? 'Voir la console\u00a0: ' + plural(errors, 'erreur', 'erreurs')
                : 'Voir la console de la page prévisualisée';
        }
        if (d.consoleCount) {
            const n = errors || consoleCount();
            d.consoleCount.hidden = !n;
            d.consoleCount.textContent = n > 99 ? '99+' : String(n);
            d.consoleCount.classList.toggle('is-error', errors > 0);
        }
        if (!d.console) return;
        d.console.hidden = !state.consoleOpen;
        if (!state.consoleOpen) return;
        if (d.consolePage) d.consolePage.textContent = state.consolePage;
        if (d.consoleSend) d.consoleSend.disabled = !entries.length || state.locked;
        if (d.consoleClear) d.consoleClear.disabled = !entries.length;
        const list = d.consoleList;
        if (!list) return;
        const atBottom = toBottom || list.scrollHeight - list.scrollTop - list.clientHeight < 8;
        list.textContent = '';
        if (!entries.length) {
            const empty = document.createElement('div');
            empty.className = 'canvas-console-empty';
            empty.textContent = state.consolePage
                ? 'Aucun message pour l\'instant.'
                : 'La console se remplit quand une page s\'affiche dans Prévisualiser.';
            list.appendChild(empty);
            return;
        }
        const frag = document.createDocumentFragment();
        for (const entry of entries) {
            const row = document.createElement('div');
            row.className = 'canvas-console-entry is-' + entry.level;
            if (entry.count > 1) {
                const repeat = document.createElement('span');
                repeat.className = 'canvas-console-repeat';
                repeat.textContent = '×' + entry.count.toLocaleString('fr-FR');
                repeat.title = `Répété ${entry.count.toLocaleString('fr-FR')} fois`;
                row.appendChild(repeat);
            }
            const text = document.createElement('span');
            text.className = 'canvas-console-text';
            text.textContent = entry.text;
            row.appendChild(text);
            if (entry.where) {
                const where = document.createElement('span');
                where.className = 'canvas-console-where';
                where.textContent = entry.where;
                row.appendChild(where);
            }
            frag.appendChild(row);
        }
        list.appendChild(frag);
        if (atBottom) list.scrollTop = list.scrollHeight;
    }

    /* Envoyée aussitôt si la saisie était vide, sinon ajoutée au message en cours */
    function sendConsoleToAi() {
        const entries = state.consoleEntries;
        const input = document.getElementById('prompt-input');
        if (!entries.length || !input || state.locked) return;
        const text = `Voici la console JavaScript de la page «\u00a0${state.consolePage}\u00a0» des Artifacts (répétitions regroupées)\u00a0:\n\n` +
            consoleSummaryLines(true).join('\n') + '\n\nCorrige les erreurs s\'il y en a.';
        const wasEmpty = !input.value.trim();
        input.value = wasEmpty ? text : input.value.replace(/\s+$/, '') + '\n\n' + text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        // Comme la touche Entrée : mêmes vérifications (modèle, réponse en cours…)
        if (wasEmpty) {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        }
    }

    // ---------- Fichiers créés, renommés, supprimés à la main ----------

    function buildNameInput(initial) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'canvas-name-input';
        input.value = initial;
        input.placeholder = initial ? '' : 'notes.md';
        input.spellcheck = false;
        input.setAttribute('autocapitalize', 'off');
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('autocorrect', 'off');
        input.setAttribute('aria-label', initial ? 'Nouveau nom de ' + initial : 'Nom du nouveau fichier');
        input.addEventListener('keydown', (e) => {
            if (e.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') {
                e.preventDefault();
                commitNaming(input.value, true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                cancelNaming();
            }
        });
        input.addEventListener('input', () => {
            setNamingError('');
            const icon = input.parentElement && input.parentElement.querySelector('.canvas-file-icon');
            if (icon) icon.innerHTML = iconForFile(input.value.trim());
        });
        // Clic ailleurs : comme Entrée, mais un nom refusé abandonne la saisie
        input.addEventListener('blur', () => { if (state.naming) commitNaming(input.value, false); });
        return input;
    }

    function setNamingError(msg) {
        const row = state._namingRow;
        if (!row) return;
        const input = row.querySelector('.canvas-name-input');
        const err = row.nextElementSibling;
        if (input) input.classList.toggle('is-invalid', !!msg);
        if (err && err.classList.contains('canvas-name-error')) {
            err.textContent = msg;
            err.hidden = !msg;
        }
    }

    function focusNameInput(selectBase) {
        const input = state._namingRow && state._namingRow.querySelector('.canvas-name-input');
        if (!input) return;
        input.focus();
        if (selectBase) {
            const v = input.value;
            const slash = v.lastIndexOf('/');
            const dot = v.lastIndexOf('.');
            input.setSelectionRange(slash + 1, dot > slash + 1 ? dot : v.length);
        }
        input.scrollIntoView({ block: 'nearest' });
    }

    function startNaming(naming) {
        if (!canManageFiles()) return;
        endEditSession();
        state.naming = naming;
        state._namingRow = null;
        if (state.activeTab !== 'code') setTab('code');
        else render();
        focusNameInput(naming.mode === 'rename');
    }

    function startNewFile() {
        if (state.mode === 'canvas') { refuseCanvasFiles(); return; }
        startNaming({ mode: 'new' });
    }

    function refuseCanvasFiles() {
        const msg = `Le Canvas ne contient qu'un texte\u00a0: déposez un seul document (${DOC_FORMATS_TEXT}) pour le remplacer. Pour du code, ouvrez une nouvelle conversation ou videz le Canvas.`;
        if (typeof window.customAlert === 'function') window.customAlert(msg, 'import');
        else flashStatus(msg, msg, true);
    }

    function startRename(name) {
        if (fileExists(name)) startNaming({ mode: 'rename', name });
    }

    function cancelNaming() {
        if (!state.naming) return;
        state.naming = null;
        state._namingRow = null;
        render();
    }

    function commitNaming(value, viaEnter) {
        const naming = state.naming;
        if (!naming) return;
        const raw = String(value || '').trim();
        if (!raw || (naming.mode === 'rename' && raw === naming.name)) { cancelNaming(); return; }
        const check = checkFileName(raw, naming.mode === 'rename' ? naming.name : null);
        if (check.error) {
            if (viaEnter) setNamingError(check.error);
            else cancelNaming();
            return;
        }
        state.naming = null;
        state._namingRow = null;
        if (naming.mode === 'new') createFile(check.name);
        else renameFile(naming.name, check.name);
    }

    /* `mode` : espace fixé par un premier fichier (sinon déduit) */
    function afterFilesChanged(mode) {
        settleUserMode(mode);
        state.previewDirty = true;
        state.lastError = null;
        render();
        notifyStateChange();
        persistNow();
    }

    function createFile(name) {
        if (!canManageFiles() || name in state.files) { render(); return; }
        pushHistory();
        state.files[name] = '';
        state.selectedFile = name;
        afterFilesChanged('artifacts');
        if (state._editor && state._editor.input) state._editor.input.focus();
    }

    function renameFile(oldName, newName) {
        if (!canManageFiles() || !fileExists(oldName) || oldName === newName) { render(); return; }
        endEditSession();
        pushHistory();
        if (oldName in state.files) {
            const content = state.files[oldName];
            delete state.files[oldName];
            state.files[newName] = content;
        } else {
            // Fichier que l'IA ne lit pas : même contenu, nouveau nom
            state.assets[newName] = state.assets[oldName];
            delete state.assets[oldName];
        }
        // « Afficher les modifications » compare toujours le même fichier
        if (oldName in state.baseline) {
            state.baseline[newName] = state.baseline[oldName];
            delete state.baseline[oldName];
        }
        if (state.lockedFiles.delete(oldName)) state.lockedFiles.add(newName);
        if (state.selectedFile === oldName) state.selectedFile = newName;
        if (state.previewCurrentFile === oldName) state.previewCurrentFile = newName;
        const nav = state.previewNav;
        if (nav && nav.from === oldName) nav.from = newName;
        if (nav && nav.page === oldName) nav.page = newName;
        afterFilesChanged();
    }

    // ---------- Fichiers verrouillés : l'IA les lit mais ne peut ni modifier, ni réécrire, ni supprimer ----------

    function isLocked(name) {
        return state.lockedFiles.has(name) && name in state.files;
    }

    function lockedList(files) {
        const list = sortFileNames([...state.lockedFiles].filter(n => files && n in files));
        return list.length ? list : undefined;
    }

    function readLocked(list) {
        return new Set(Array.isArray(list) ? list.filter(n => typeof n === 'string' && n in state.files) : []);
    }

    function toggleLock(name) {
        if (!canManageFiles() || !(name in state.files)) return;
        const lock = !state.lockedFiles.has(name);
        if (lock) state.lockedFiles.add(name);
        else state.lockedFiles.delete(name);
        flashStatus(lock ? `«\u00a0${name}\u00a0» verrouillé\u00a0: l'IA ne peut plus le modifier` : `«\u00a0${name}\u00a0» déverrouillé\u00a0: l'IA peut de nouveau le modifier`, '');
        render();
        notifyStateChange();
        persistNow();
    }

    function lockedPromptBlock() {
        const names = lockedList(state.files);
        if (!names) return '';
        return '\n\n--- fichiers verrouillés par l\'utilisateur ---\n' + names.join('\n') +
            '\n--- fin de la liste ---\nTu peux les lire, mais ni les modifier, ni les réécrire, ni les supprimer. Si la demande l\'exige, dis-le à l\'utilisateur : lui seul peut les déverrouiller.';
    }

    async function deleteFile(name) {
        if (!canManageFiles() || !fileExists(name)) return;
        endEditSession();
        const seq = state._loadSeq;
        // Le dernier fichier vide les Artifacts, et leur historique avec
        const last = allFileNames().length === 1;
        const msg = last
            ? `Supprimer le fichier «\u00a0${name}\u00a0»\u00a0? C'est le dernier\u00a0: les Artifacts seront vides, et l'historique de leurs versions effacé.`
            : `Supprimer le fichier «\u00a0${name}\u00a0»\u00a0? L'historique des versions permet de le récupérer.`;
        const ok = typeof window.customConfirm === 'function'
            ? await window.customConfirm(msg, { icon: 'delete', danger: true, okLabel: 'Supprimer' })
            : window.confirm(msg);
        // Entre-temps : autre conversation affichée, ou réponse de l'IA commencée
        if (!ok || seq !== state._loadSeq || !canManageFiles() || !fileExists(name)) return;
        const names = sortFileNames(allFileNames());
        const idx = names.indexOf(name);
        pushHistory();
        delete state.files[name];
        delete state.assets[name];
        state.lockedFiles.delete(name);
        if (state.selectedFile === name) state.selectedFile = names[idx + 1] || names[idx - 1] || null;
        if (state.previewCurrentFile === name) state.previewCurrentFile = null;
        if (state.previewNav && (state.previewNav.from === name || state.previewNav.page === name)) state.previewNav = null;
        afterFilesChanged();
    }

    function selectFromList(name) {
        if (state.selectedFile === name) return;
        state.selectedFile = name;
        // Choisi pendant que l'IA écrit : l'écriture ne le remplace pas
        if (state.streamingFile || state.busy) {
            state._streamSelectPinned = name;
            state._streamSelectManual = true;
            state._turnPicked = true;
        }
        if (previewTarget() !== state.previewCurrentFile) state.previewDirty = true;
        render();
    }

    // ---------- Fichiers que l'IA ne lit pas (contenu à part dans canvas_assets, par empreinte) ----------

    const PROJECT_MAX_BYTES = 50 * 1024 * 1024;
    // Texte lu par l'IA : par fichier, et en tout (au-delà, grisé)
    const TEXT_MAX_FILE_BYTES = 1024 * 1024;
    const TEXT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
    const ASSET_WHY = {
        binary: 'fichier non texte',
        generated: 'fichier minifié ou généré',
        secret: 'fichier de secrets (.env)',
        large: 'texte trop gros pour l\'IA'
    };
    const MIME_BY_EXT = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
        ico: 'image/x-icon', bmp: 'image/bmp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff',
        woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
        mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus',
        flac: 'audio/flac', aac: 'audio/aac', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
        pdf: 'application/pdf', json: 'application/json', map: 'application/json', js: 'text/javascript',
        mjs: 'text/javascript', cjs: 'text/javascript', css: 'text/css', html: 'text/html', htm: 'text/html',
        txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', xml: 'application/xml', wasm: 'application/wasm',
        zip: 'application/zip'
    };
    // Contenus déjà lus (session) : Blob, data: URL (aperçu), texte (minifiés), adresse blob: (volet)
    const assetBlobs = new Map();
    const assetDataUrls = new Map();
    const assetTexts = new Map();
    const assetObjectUrls = new Map();
    // Jamais libérées avant l'enregistrement de la conversation (gcCanvasAssets d'app.js)
    const recentAssetHashes = new Set();

    function mimeOf(name) {
        return MIME_BY_EXT[fileExtension(name)] || 'application/octet-stream';
    }

    function assetKindLabel(name, type) {
        const t = type || mimeOf(name);
        if (t.startsWith('image/')) return 'image';
        if (t.startsWith('font/') || /fontobject/.test(t)) return 'police';
        if (t.startsWith('audio/')) return 'son';
        if (t.startsWith('video/')) return 'vidéo';
        if (t === 'application/pdf') return 'PDF';
        if (/javascript|css|json|html|xml|text\//.test(t)) return 'code';
        return 'fichier';
    }

    const hasAssets = () => Object.keys(state.assets).length > 0;
    function isAsset(name) { return !!name && Object.prototype.hasOwnProperty.call(state.assets, name); }
    function fileExists(name) { return !!name && (state.files[name] != null || isAsset(name)); }
    function allFileNames() { return Object.keys(state.files).concat(Object.keys(state.assets).filter(n => state.files[n] == null)); }
    /* Des fichiers non lisibles seuls font des Artifacts */
    function currentMode() { return normalizeMode(state.mode, state.files) || (hasAssets() ? 'artifacts' : null); }

    function cloneAssets(assets) {
        const copy = Object.create(null);
        for (const k in assets || {}) {
            const a = assets[k];
            if (a && typeof a.hash === 'string') copy[k] = { hash: a.hash, type: String(a.type || ''), size: Number(a.size) || 0, why: a.why || 'binary' };
        }
        return copy;
    }

    /* SHA-256, sinon (contexte sans crypto.subtle) une empreinte de 64 bits et la taille */
    async function hashBytes(bytes) {
        const sha = await sha256Hex(bytes);
        return sha || fallbackHash(bytes);
    }
    async function sha256Hex(bytes) {
        try {
            if (window.crypto && crypto.subtle) {
                const digest = await crypto.subtle.digest('SHA-256', bytes);
                return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
            }
        } catch (e) { /* sans SHA-256 */ }
        return '';
    }
    /* Sauvegarde importée : sans SHA-256, l'empreinte est acceptée */
    async function assetHashMatches(hash, bytes) {
        if (/^f[0-9a-f]{16}-\d+$/.test(hash)) return fallbackHash(bytes) === hash;
        const sha = await sha256Hex(bytes);
        return !sha || sha === hash;
    }
    function fallbackHash(bytes) {
        let h1 = 0xdeadbeef ^ bytes.length, h2 = 0x41c6ce57 ^ bytes.length;
        for (let i = 0; i < bytes.length; i++) {
            h1 = Math.imul(h1 ^ bytes[i], 2654435761);
            h2 = Math.imul(h2 ^ bytes[i], 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return 'f' + (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0') + '-' + bytes.length;
    }

    async function storeAsset(path, bytes, why) {
        const type = mimeOf(path);
        const blob = new Blob([bytes], { type });
        const hash = await hashBytes(bytes);
        if (typeof putCanvasAsset !== 'function') throw new Error('Stockage des fichiers indisponible');
        await putCanvasAsset(hash, blob);
        recentAssetHashes.add(hash);
        assetBlobs.set(hash, blob);
        return { hash, type, size: bytes.length, why };
    }

    async function assetBlob(hash) {
        if (assetBlobs.has(hash)) return assetBlobs.get(hash);
        let blob = null;
        try { blob = typeof getCanvasAsset === 'function' ? await getCanvasAsset(hash) : null; }
        catch (e) { console.warn('[canvas] fichier introuvable dans le stockage :', hash, e); }
        if (blob) assetBlobs.set(hash, blob);
        return blob;
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => resolve('');
            reader.readAsDataURL(blob);
        });
    }

    async function loadAssetsForPreview(names) {
        let ok = true;
        await Promise.all(names.map(async (name) => {
            const a = state.assets[name];
            if (!a || assetDataUrls.has(a.hash)) return;
            const blob = await assetBlob(a.hash);
            if (!blob) { assetDataUrls.set(a.hash, ''); ok = false; return; }
            const typed = blob.type ? blob : new Blob([blob], { type: a.type || mimeOf(name) });
            assetDataUrls.set(a.hash, await blobToDataUrl(typed));
            if (/\.(?:js|mjs|cjs|css)$/i.test(name)) assetTexts.set(a.hash, await blob.text());
        }));
        return ok;
    }

    async function assetObjectUrl(hash) {
        if (assetObjectUrls.has(hash)) return assetObjectUrls.get(hash);
        const blob = await assetBlob(hash);
        if (!blob) return null;
        const url = URL.createObjectURL(blob);
        assetObjectUrls.set(hash, url);
        return url;
    }

    /* Contenus des fichiers non lisibles hors de la conversation affichée : libérés (blob: révoqués), relus au besoin */
    function pruneAssetCaches() {
        const keep = new Set(Object.keys(state.assets).map(n => state.assets[n] && state.assets[n].hash));
        for (const map of [assetBlobs, assetDataUrls, assetTexts]) {
            for (const h of [...map.keys()]) if (!keep.has(h)) map.delete(h);
        }
        for (const [h, url] of [...assetObjectUrls]) {
            if (keep.has(h)) continue;
            assetObjectUrls.delete(h);
            try { URL.revokeObjectURL(url); } catch (e) { /* déjà révoquée */ }
        }
    }

    function assetTooltip(name) {
        const a = state.assets[name];
        if (!a) return name;
        return `${name}\n${assetKindLabel(name, a.type)} · ${formatSize(a.size)}\nL'IA ne peut ni lire ni modifier ce fichier (${ASSET_WHY[a.why] || ASSET_WHY.binary}) : il sert à l'aperçu et au téléchargement.`;
    }

    function assetsPromptBlock() {
        const names = sortFileNames(Object.keys(state.assets).filter(n => state.files[n] == null));
        if (!names.length) return '';
        const shown = names.slice(0, 60).map(n => {
            const a = state.assets[n];
            return `${n} — ${assetKindLabel(n, a.type)}, ${formatSize(a.size)}${a.why === 'large' ? ', trop gros' : a.why === 'generated' ? ', minifié ou généré' : ''}`;
        });
        const more = names.length - shown.length;
        if (more > 0) {
            const dirs = [...new Set(names.slice(60).map(n => n.includes('/') ? n.slice(0, n.lastIndexOf('/') + 1) : './'))].slice(0, 6);
            shown.push(`… et ${more} autre${more > 1 ? 's' : ''} (dans ${dirs.join(', ')})`);
        }
        return '\n\n--- fichiers du projet que tu ne peux ni lire ni modifier ---\n' + shown.join('\n') +
            '\n--- fin de la liste ---\nIls existent bien : tu peux y faire référence par leur chemin (image, police, script…), mais pas les lire, les réécrire, les renommer ni les supprimer.';
    }

    // ---------- Import de fichiers ----------
    // Tout est gardé (50 Mo au plus) ; seuls dossiers techniques, fichiers système et noms invalides sont écartés

    function newImportReport() {
        return { assets: { binary: 0, generated: 0, secret: 0, large: 0 }, name: 0, extra: 0, tooBig: 0, storeErrors: 0, dirs: new Set(), zipErrors: [] };
    }

    function fileSource(file, path, top) {
        return { path, size: file.size, file, top, read: async () => new Uint8Array(await file.arrayBuffer()) };
    }

    async function collectEntries(entries, report) {
        const out = [];
        let visited = 0;
        async function walk(entry, prefix, top) {
            if (visited > IMPORT_MAX_FILES * 4) { report.extra++; return; }
            if (entry.isDirectory) {
                if (IMPORT_SYSTEM_DIRS.test(entry.name)) return;
                if (IMPORT_IGNORED_DIRS.test(entry.name)) { report.dirs.add(entry.name); return; }
                const reader = entry.createReader();
                for (;;) {
                    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
                    if (!batch.length) break;
                    for (const child of batch) await walk(child, prefix + entry.name + '/', false);
                }
            } else if (entry.isFile) {
                visited++;
                const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
                out.push(fileSource(file, prefix + entry.name, top));
            }
        }
        for (const entry of entries) await walk(entry, '', true);
        return out;
    }

    async function expandZip(src, out, report) {
        if (typeof JSZip === 'undefined') { report.zipErrors.push(src.path); return; }
        try {
            const zip = await JSZip.loadAsync(src.file);
            zip.forEach((path, entry) => {
                if (!entry.dir) out.push({ path, size: null, read: () => entry.async('uint8array') });
            });
        } catch (e) {
            console.warn('[canvas] ZIP illisible :', src.path, e);
            report.zipErrors.push(src.path);
        }
    }

    function importSkipReason(path, report) {
        const segs = path.split('/');
        const base = segs[segs.length - 1];
        if (segs.slice(0, -1).some(s => IMPORT_SYSTEM_DIRS.test(s))) return 'system';
        const dir = segs.slice(0, -1).find(s => IMPORT_IGNORED_DIRS.test(s));
        if (dir) { report.dirs.add(dir); return 'dir'; }
        if (IMPORT_SYSTEM_FILES.test(base)) return 'system';
        if (IMPORT_SECRET_FILES.test(base)) return 'secret';
        if (IMPORT_GENERATED_FILES.test(base)) return 'generated';
        if (IMPORT_BINARY_EXT.test(base)) return 'binary';
        if (BAD_NAME_CHARS.test(path)) return 'name';
        return null;
    }

    /* UTF-8, UTF-16 avec BOM, sinon Windows-1252 ; fins de ligne Windows converties pour les <find> de l'IA */
    function decodeText(bytes) {
        let text;
        if (bytes[0] === 0xFF && bytes[1] === 0xFE) text = new TextDecoder('utf-16le').decode(bytes);
        else if (bytes[0] === 0xFE && bytes[1] === 0xFF) text = new TextDecoder('utf-16be').decode(bytes);
        else {
            const n = Math.min(bytes.length, 8000);
            for (let i = 0; i < n; i++) if (bytes[i] === 0) return null;
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
            catch (e) { text = new TextDecoder('windows-1252').decode(bytes); }
        }
        // Caractères de contrôle en nombre : fichier binaire
        const sample = text.slice(0, 8000);
        const controls = (sample.match(/[\x00-\x08\x0e-\x1a\x1c-\x1f\x7f\x80-\x9f\ufffd]/g) || []).length;
        if (controls > Math.max(8, sample.length / 200)) return null;
        return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    }

    function importReportText(count, replaced, r) {
        const parts = [];
        const why = [];
        const a = r.assets;
        const unread = a.binary + a.generated + a.secret + a.large;
        if (unread) {
            const kinds = [];
            if (a.binary) kinds.push(plural(a.binary, 'fichier non texte (image, police…)', 'fichiers non texte (images, polices…)'));
            if (a.generated) kinds.push(plural(a.generated, 'fichier minifié ou généré', 'fichiers minifiés ou générés'));
            if (a.secret) kinds.push(plural(a.secret, 'fichier .env', 'fichiers .env'));
            if (a.large) kinds.push(plural(a.large, `texte de plus de ${formatSize(TEXT_MAX_FILE_BYTES)}`, `textes de plus de ${formatSize(TEXT_MAX_FILE_BYTES)}`));
            why.push('Grisés, que l\'IA ne lit pas (elle sait seulement qu\'ils existent) : ' + kinds.join(', ') + '. Ils servent à l\'aperçu et au téléchargement.');
        }
        if (r.name) parts.push(plural(r.name, 'nom invalide', 'noms invalides'));
        if (r.dirs.size) {
            parts.push(Array.from(r.dirs).join(', '));
            why.push('Dossiers ' + Array.from(r.dirs).join(', ') + ' : dépendances ou fichiers de travail.');
        }
        if (r.extra) parts.push(`au-delà de ${IMPORT_MAX_FILES} fichiers`);
        if (r.tooBig) {
            parts.push(`au-delà de ${formatSize(PROJECT_MAX_BYTES)}`);
            why.push(`Un projet garde ${formatSize(PROJECT_MAX_BYTES)} de fichiers au plus.`);
        }
        if (r.storeErrors) parts.push(plural(r.storeErrors, 'fichier non enregistré', 'fichiers non enregistrés'));
        if (r.zipErrors.length) parts.push('ZIP illisible\u00a0: ' + r.zipErrors.join(', '));
        let text = count ? plural(count, 'fichier importé', 'fichiers importés') : 'Aucun fichier importé';
        if (unread && count) text += `, dont ${unread} que l'IA ne lit pas`;
        if (replaced) text += replaced > 1 ? ` (${replaced} remplacés)` : ' (1 remplacé)';
        if (parts.length) text += (count ? ' · ignorés\u00a0: ' : '\u00a0: ') + parts.join(', ');
        return { text, why, title: [text, ...why].join('\n') };
    }

    /* Fichier de même nom à la casse près : remplacé */
    function mergeImport(items) {
        const existing = new Map(allFileNames().map(n => [n.toLowerCase(), n]));
        const after = cloneFiles(state.files);
        const afterAssets = cloneAssets(state.assets);
        let replaced = 0, importBytes = 0;
        for (const it of items) {
            const old = existing.get(it.path.toLowerCase());
            if (old != null) { replaced++; delete after[old]; delete afterAssets[old]; }
            if (it.asset) {
                afterAssets[it.path] = it.asset;
                importBytes += it.asset.size;
            } else {
                after[it.path] = it.text;
                importBytes += byteSize(it.text);
            }
        }
        return { after, afterAssets, replaced, importBytes };
    }

    function projectBytes() {
        let n = 0;
        for (const k in state.files) n += byteSize(state.files[k]);
        for (const k in state.assets) if (state.files[k] == null) n += state.assets[k].size || 0;
        return n;
    }

    /* toArtifacts : « Importer » des Artifacts ; sinon fichiers glissés (un document seul ouvre le Canvas vide) */
    async function importFiles(collect, toArtifacts) {
        if (!canManageFiles()) return;
        const seq = state._loadSeq;
        const report = newImportReport();
        let sources = [];
        try { sources = await collect(report); }
        catch (e) { console.warn('[canvas] import :', e); }
        // Canvas : un document seul en remplace le texte ; volet vide : un document seul devient le Canvas
        if (!toArtifacts && seq === state._loadSeq) {
            const single = sources.length === 1 && sources[0].top && sources[0].file ? sources[0] : null;
            if (state.mode === 'canvas') {
                if (single && DOC_IMPORT_RE.test(single.path)) await importDocument(single.file);
                else refuseCanvasFiles();
                return;
            }
            if (single && !state.mode && !allFileNames().length && DOC_DROP_RE.test(single.path)) {
                await importDocument(single.file);
                return;
            }
        }
        const expanded = [];
        for (const src of sources) {
            if (src.top && /\.zip$/i.test(src.path)) await expandZip(src, expanded, report);
            else expanded.push(src);
        }
        // Taille pendant la lecture : fichiers gardés plus ceux lus (un fichier remplacé n'est pas compté deux fois)
        const sizeOf = new Map(allFileNames().map(n => [n.toLowerCase(), state.files[n] != null ? byteSize(state.files[n]) : (state.assets[n].size || 0)]));
        let totalBytes = projectBytes();
        // Dossier unique autour de tout (ZIP d'un dossier, dossier glissé) retiré des chemins : les remplacés sont reconnus
        const kept0 = expanded.map(src => normalizePath(src.path)).filter(p => p && !/^(?:system|dir)$/.test(importSkipReason(p, report) || ''));
        const roots = new Set(kept0.map(p => p.split('/')[0]));
        const strip = roots.size === 1 && kept0.length && kept0.every(p => p.includes('/')) ? kept0[0].indexOf('/') + 1 : 0;
        const accepted = new Map(); // chemin en minuscules → { path, text } ou { path, bytes, why }
        if (expanded.length > 20) flashStatus('Import en cours…', '');
        for (const src of expanded) {
            const full = normalizePath(src.path);
            if (!full) continue;
            const path = strip && full.length > strip ? full.slice(strip) : full;
            const reason = importSkipReason(path, report);
            if (reason === 'system' || reason === 'dir') continue;
            if (reason === 'name') { report.name++; continue; }
            if (accepted.size >= IMPORT_MAX_FILES) { report.extra++; continue; }
            const lower = path.toLowerCase();
            const freed = accepted.has(lower) ? 0 : (sizeOf.get(lower) || 0);
            if (src.size != null && totalBytes - freed + src.size > PROJECT_MAX_BYTES) { report.tooBig++; continue; }
            let bytes;
            try { bytes = await src.read(); }
            catch (e) { console.warn('[canvas] lecture impossible :', path, e); continue; }
            if (totalBytes - freed + bytes.length > PROJECT_MAX_BYTES) { report.tooBig++; continue; }
            totalBytes += bytes.length - freed;
            sizeOf.delete(lower);
            // Fichier que l'IA ne lit pas : .env, minifié ou généré, non texte, trop gros
            let why = reason === 'secret' || reason === 'generated' || reason === 'binary' ? reason : null;
            let text = null;
            if (!why) {
                text = decodeText(bytes);
                if (text == null) why = 'binary';
                else if (bytes.length > TEXT_MAX_FILE_BYTES) why = 'large';
            }
            accepted.set(lower, why ? { path, bytes, why } : { path, text });
        }
        // Autre conversation affichée pendant la lecture : on abandonne
        if (seq !== state._loadSeq) return;
        const items = Array.from(accepted.values());
        // Le Canvas s'est ouvert pendant la lecture (réponse de l'IA) : rien d'autre
        if (state.mode === 'canvas') { refuseCanvasFiles(); return; }
        // Texte lu par l'IA : 10 Mo en tout ; au-delà, les plus gros sont grisés
        let textBytes = 0;
        for (const k in state.files) if (!accepted.has(k.toLowerCase())) textBytes += byteSize(state.files[k]);
        for (const it of items.filter(x => x.text != null).sort((a, b) => a.text.length - b.text.length)) {
            const n = byteSize(it.text);
            if (textBytes + n > TEXT_MAX_TOTAL_BYTES) { it.bytes = new TextEncoder().encode(it.text); it.why = 'large'; it.text = null; }
            else textBytes += n;
        }
        if (!items.length) {
            const none = importReportText(0, 0, report);
            if (typeof window.customAlert === 'function') {
                window.customAlert(none.text + '.' + (none.why.length ? '\n\n' + none.why.join('\n') : ''), 'import');
            } else {
                flashStatus(none.text, none.title, true);
            }
            return;
        }
        for (const it of items) {
            if (it.text != null) continue;
            try {
                it.asset = await storeAsset(it.path, it.bytes, it.why);
                report.assets[it.why]++;
            } catch (e) {
                console.warn('[canvas] fichier non enregistré :', it.path, e);
                report.storeErrors++;
                it.failed = true;
            }
            it.bytes = null;
        }
        if (seq !== state._loadSeq) return;
        const kept = items.filter(it => !it.failed);
        // Gros projet : pas de confirmation (l'IA lit les fichiers utiles), mais le bilan de l'import le signale
        const { after, importBytes } = mergeImport(kept);
        const afterBytes = Object.keys(after).reduce((s, n) => s + byteSize(after[n]), 0);
        let afterTokens = 0;
        for (const n in after) afterTokens += fileTokens(after[n]);
        const large = afterTokens > FULL_CONTEXT_MAX_TOKENS;
        if (!large && afterBytes > IMPORT_CONFIRM_SIZE && typeof window.customConfirm === 'function') {
            let chars = ARTIFACTS_PROMPT.length + ARTIFACTS_REMINDER.length + 40;
            for (const n in after) chars += n.length + after[n].length + 10;
            const tokens = roundTokens(Math.round(chars / CHARS_PER_TOKEN));
            const ok = await window.customConfirm(
                `Importer ${plural(kept.length, 'fichier', 'fichiers')} (${formatSize(importBytes)}) ?\n\n` +
                `Tous les fichiers des Artifacts sont envoyés à l'IA à chaque message : environ ${tokens} tokens par message après l'import. ` +
                'C\'est plus cher, et certains modèles ne peuvent pas en lire autant.',
                { icon: 'import', okLabel: 'Importer' }
            );
            if (!ok || seq !== state._loadSeq) return;
        }
        if (!canManageFiles()) {
            flashStatus('Import annulé : l\'IA a commencé à répondre', '', true);
            return;
        }
        endEditSession();
        // Recalculé : le canvas a pu changer pendant la confirmation
        const merged = mergeImport(kept);
        pushHistory();
        state.files = merged.after;
        state.assets = merged.afterAssets;
        const names = kept.map(it => it.path);
        const readable = kept.filter(it => !it.asset).map(it => it.path);
        state.selectedFile = readable.find(n => n === DEFAULT_ENTRYPOINT) || readable.find(isHtmlFile)
            || readable.find(isMarkdownFile) || sortFileNames(readable.slice())[0] || sortFileNames(names.slice())[0];
        state.previewCurrentFile = null;
        state.previewNav = null;
        // Un document seul glissé sur le volet vide est allé dans le Canvas (importDocument)
        afterFilesChanged('artifacts');
        const summary = importReportText(kept.length, merged.replaced, report);
        if (large) {
            summary.text += ' · gros projet : l\'IA lira les fichiers utiles';
            summary.title = (summary.title ? summary.title + '\n\n' : '') + 'Gros projet : l\'IA ne reçoit plus tous les fichiers à chaque message, mais leur liste avec leur plan, et lit ceux dont elle a besoin.';
        }
        flashStatus(summary.text, summary.title);
    }

    // ---------- Import d'un document dans le Canvas ----------
    // Word par mammoth (chargé à la demande), PDF par pdf.js, page web nettoyée comme un collage

    const DOC_IMPORT_RE = /\.(?:docx|pdf|md|markdown|txt|html?)$/i;
    const DOC_IMPORT_ACCEPT = '.docx,.pdf,.md,.markdown,.txt,.html,.htm';
    // Un .txt ou une page web glissé seul va dans les Artifacts, pas dans le Canvas
    const DOC_DROP_RE = /\.(?:docx|pdf|md|markdown)$/i;
    const DOC_IMPORT_MAX_BINARY = 25 * 1024 * 1024;   // .docx et .pdf, images comprises
    const MAMMOTH_SRC = 'https://cdn.jsdelivr.net/npm/mammoth@1.13.0/mammoth.browser.min.js';
    const MAMMOTH_SRI = 'sha384-8NWE3bZDrmRI4IePMoQaEoLhAQ1MmRMJkdNgnGiHRFanTqsFKr0TmK6aSZvFJ/PO';
    const DOC_FORMATS_TEXT = 'Word (.docx), PDF, Markdown, texte ou page web';
    let mammothLoading = null;

    function loadMammoth() {
        if (window.mammoth && typeof window.mammoth.convertToHtml === 'function') return Promise.resolve(window.mammoth);
        if (!mammothLoading) {
            mammothLoading = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = MAMMOTH_SRC;
                script.integrity = MAMMOTH_SRI;
                script.crossOrigin = 'anonymous';
                script.onload = () => (window.mammoth ? resolve(window.mammoth) : reject(new Error('mammoth')));
                script.onerror = () => { script.remove(); reject(new Error('mammoth')); };
                document.head.appendChild(script);
            });
            // Échec (hors ligne) : une prochaine tentative recharge le script
            mammothLoading.catch(() => { mammothLoading = null; });
        }
        return mammothLoading;
    }

    /* PDF en Markdown : paragraphes par espacement, titres par taille, puces ; numéros de page retirés */
    async function pdfToMarkdown(buffer, name) {
        if (typeof pdfjsLib === 'undefined') {
            throw new Error('La lecture des PDF n\'est pas disponible\u00a0: vérifiez la connexion à Internet, puis rechargez DavidTwentyAI.');
        }
        let pdf;
        try { pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise; }
        catch (e) {
            throw new Error(e && e.name === 'PasswordException'
                ? `«\u00a0${name}\u00a0» est protégé par un mot de passe.`
                : `«\u00a0${name}\u00a0» n'est pas un PDF lisible.`);
        }
        // Lignes : texte, hauteur des caractères, ligne de base, page
        const lines = [];
        for (let p = 1; p <= pdf.numPages; p++) {
            const page = await pdf.getPage(p);
            const tc = await page.getTextContent();
            const pageLines = [];
            let cur = null;
            for (const it of tc.items) {
                if (typeof it.str !== 'string') continue;
                if (!cur) cur = { text: '', y: null, h: 0, left: 0, right: 0, page: p };
                cur.text += it.str;
                if (it.str.trim()) {
                    const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 0;
                    if (cur.y == null) { cur.y = it.transform[5]; cur.left = it.transform[4]; }
                    cur.h = Math.max(cur.h, size);
                    cur.right = Math.max(cur.right, it.transform[4] + (it.width || 0));
                }
                if (it.hasEOL) { pageLines.push(cur); cur = null; }
            }
            if (cur) pageLines.push(cur);
            // Numéro de page seul en haut ou en bas de la page
            const filled = pageLines.filter(l => l.text.trim());
            for (const l of [filled[0], filled[filled.length - 1]]) {
                if (l && /^\s*(?:page\s*)?\d{1,4}(?:\s*\/\s*\d{1,4})?\s*$/i.test(l.text)) l.text = '';
            }
            // Ligne qui s'arrête avant le bord droit alors que le mot suivant y tenait : fin de paragraphe
            const rights = filled.filter(l => l.text.trim()).map(l => l.right).sort((a, b) => b - a);
            const full = rights.length ? rights[Math.min(rights.length - 1, Math.floor(rights.length / 10))] : 0;
            for (const l of pageLines) l.full = full;
            lines.push(...pageLines);
            page.cleanup();
        }
        const real = lines.filter(l => l.text.trim());
        if (!real.length) throw new Error(`«\u00a0${name}\u00a0» ne contient pas de texte à reprendre (document scanné\u00a0?).`);
        const mostCommon = (map) => [...map.entries()].sort((a, b) => b[1] - a[1])[0][0];
        const sizes = new Map();
        for (const l of real) { const k = Math.round(l.h * 2) / 2; sizes.set(k, (sizes.get(k) || 0) + l.text.length); }
        const body = mostCommon(sizes) || 10;
        const gaps = new Map();
        for (let i = 1; i < real.length; i++) {
            const a = real[i - 1], b = real[i];
            const g = Math.round((a.y - b.y) * 2) / 2;
            if (a.page === b.page && g > 0 && Math.abs(a.h - body) < 0.6 && Math.abs(b.h - body) < 0.6) gaps.set(g, (gaps.get(g) || 0) + 1);
        }
        const lead = gaps.size ? mostCommon(gaps) : body * 1.2;
        const LIGATURES = { '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl', '\uFB03': 'ffi', '\uFB04': 'ffl', '\uFB05': 'st', '\uFB06': 'st' };
        const BULLET = /^[•◦▪▫●○‣∙⁃–-]\s+/;
        const blocks = [];
        let cur = null, prev = null;
        for (const l of lines) {
            const t = l.text.replace(/[\uFB00-\uFB06]/g, c => LIGATURES[c]).replace(/\s+/g, ' ').trim();
            if (!t) { cur = null; prev = null; continue; }
            const kind = l.h >= body * 1.6 ? 'h1' : l.h >= body * 1.2 ? 'h2' : 'p';
            const bullet = kind === 'p' && BULLET.test(t);
            const gap = prev && prev.page === l.page ? prev.y - l.y : -1;
            const sameKind = cur && (cur.type === kind || (cur.type === 'li' && kind === 'p'));
            if (cur && sameKind && !bullet && gap > 0 && gap <= Math.max(lead, l.h) * 1.4) {
                // Après une ligne courte, retour à la ligne ; sinon même paragraphe (mot coupé recollé)
                const charW = Math.max(1, l.right - l.left) / Math.max(1, t.length);
                const firstWord = ((/^\S+/.exec(t) || [''])[0].length + 2) * charW;
                const short = prev.full > 0 && prev.full - prev.right > firstWord;
                cur.text += short ? '\n' + t : (/\p{L}-$/u.test(cur.text) ? '' : ' ') + t;
            } else {
                cur = { type: bullet ? 'li' : kind, text: bullet ? t.replace(BULLET, '') : t };
                blocks.push(cur);
            }
            prev = l;
        }
        // Un « titre » long est du texte en gros caractères
        for (const b of blocks) if ((b.type === 'h1' || b.type === 'h2') && b.text.length > 150) b.type = 'p';
        return window.CanvasDoc.blocksToMarkdown(blocks);
    }

    /* Renvoie { text, title, notes } (notes : ce qui n'a pas été repris) ; erreur : message pour l'utilisateur */
    async function documentToMarkdown(file) {
        const name = file.name || 'document';
        const m = /\.([^.]+)$/.exec(name);
        const ext = m ? m[1].toLowerCase() : '';
        const CD = window.CanvasDoc;
        const formatted = !!(CD && CD.canRender());
        if (ext !== 'md' && ext !== 'markdown' && ext !== 'txt' && !formatted) {
            throw new Error('La conversion des documents n\'est pas disponible\u00a0: vérifiez la connexion à Internet, puis rechargez DavidTwentyAI.');
        }
        const notes = [];
        const imagesNote = n => { if (n) notes.push(plural(n, 'image non reprise', 'images non reprises')); };
        if (ext === 'docx') {
            let mammoth;
            try { mammoth = await loadMammoth(); }
            catch (e) { throw new Error('La lecture des documents Word n\'a pas pu être chargée\u00a0: vérifiez la connexion à Internet, puis réessayez.'); }
            let res;
            try {
                res = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() }, {
                    styleMap: ['p[style-name=\'Title\'] => h1:fresh', 'p[style-name=\'Subtitle\'] => h2:fresh']
                });
            } catch (e) {
                throw new Error(`«\u00a0${name}\u00a0» n'est pas un document Word lisible.`);
            }
            const r = CD.htmlToMarkdown(res.value);
            imagesNote(r.images);
            return { text: r.text, title: '', notes };
        }
        if (ext === 'pdf') {
            const text = await pdfToMarkdown(await file.arrayBuffer(), name);
            notes.push('mise en page du PDF non reprise');
            return { text, title: '', notes };
        }
        const text = decodeText(new Uint8Array(await file.arrayBuffer()));
        if (text == null) throw new Error(`«\u00a0${name}\u00a0» n'est pas un fichier texte.`);
        if (ext === 'html' || ext === 'htm') {
            const r = CD.htmlToMarkdown(text);
            imagesNote(r.images);
            return { text: r.text, title: r.title, notes };
        }
        return { text, title: '', notes };
    }

    function importAlert(msg) {
        if (typeof window.customAlert === 'function') window.customAlert(msg, 'import');
        else flashStatus(msg, msg, true);
    }

    async function importDocument(file) {
        if (!file || !canManageFiles() || state._importingDoc) return;
        const seq = state._loadSeq;
        const name = file.name || 'document';
        if (state.mode === 'artifacts' || (!state.mode && Object.keys(state.files).length)) {
            importAlert('Cette conversation utilise les Artifacts\u00a0: le Canvas n\'y est pas disponible. Videz les Artifacts, ou ouvrez une nouvelle conversation.');
            return;
        }
        if (!DOC_IMPORT_RE.test(name)) {
            importAlert(`«\u00a0${name}\u00a0» ne peut pas être importé dans le Canvas.\n\nFormats acceptés\u00a0: ${DOC_FORMATS_TEXT}.`
                + (/\.(?:doc|odt|rtf|pages)$/i.test(name) ? ' Enregistrez d\'abord le document au format Word (.docx) ou PDF.' : ''));
            return;
        }
        const binary = /\.(?:docx|pdf)$/i.test(name);
        if (file.size > (binary ? DOC_IMPORT_MAX_BINARY : IMPORT_MAX_FILE_SIZE)) {
            importAlert(`«\u00a0${name}\u00a0» est trop volumineux (${formatSize(file.size)}, ${formatSize(binary ? DOC_IMPORT_MAX_BINARY : IMPORT_MAX_FILE_SIZE)} au plus).`);
            return;
        }
        state._importingDoc = true;
        let result;
        try {
            if (binary) flashStatus(`Import de «\u00a0${name}\u00a0»…`, '');
            result = await documentToMarkdown(file);
        } catch (e) {
            console.warn('[canvas] import du document :', e);
            if (seq === state._loadSeq) {
                state._statusFlash = null;
                renderStatus(dom());
                importAlert(e && e.message ? e.message : `«\u00a0${name}\u00a0» n'a pas pu être lu.`);
            }
            return;
        } finally {
            state._importingDoc = false;
        }
        if (seq !== state._loadSeq) return;
        const text = String(result.text || '').replace(/\r\n?/g, '\n').trim();
        if (!text) { importAlert(`«\u00a0${name}\u00a0» ne contient pas de texte.`); return; }
        if (byteSize(text) > IMPORT_MAX_FILE_SIZE) {
            importAlert(`Le texte de «\u00a0${name}\u00a0» est trop long pour le Canvas (${formatSize(byteSize(text))}, ${formatSize(IMPORT_MAX_FILE_SIZE)} au plus).`);
            return;
        }
        // Confirmation pour un texte lourd ; le document s'ajoute à côté, jamais de texte remplacé
        const replacing = false;
        const heavy = byteSize(text) > IMPORT_CONFIRM_SIZE;
        if (replacing || heavy) {
            let msg = replacing
                ? `Remplacer le texte du Canvas par celui de «\u00a0${name}\u00a0»\u00a0? L'historique des versions permet de revenir en arrière.`
                : `Importer «\u00a0${name}\u00a0» dans le Canvas\u00a0?`;
            if (heavy) {
                msg += `\n\nTout le texte du Canvas est envoyé à l'IA à chaque message\u00a0: environ ${roundTokens(Math.round(text.length / CHARS_PER_TOKEN))} tokens par message. `
                    + 'C\'est plus cher, et certains modèles ne peuvent pas en lire autant.';
            }
            const ok = typeof window.customConfirm === 'function'
                ? await window.customConfirm(msg, { icon: 'import', okLabel: replacing ? 'Remplacer' : 'Importer' })
                : window.confirm(msg);
            if (!ok || seq !== state._loadSeq) return;
        }
        if (!canManageFiles()) {
            flashStatus('Import annulé\u00a0: l\'IA a commencé à répondre', '', true);
            return;
        }
        if (state.mode === 'artifacts' || (!state.mode && Object.keys(state.files).length)) return;
        endEditSession();
        pushHistory();
        // Titre : celui de la page web, sinon le premier titre du texte, sinon le nom du fichier
        const fileTitle = name.replace(/\.[^.]+$/, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
        const title = resolveDocTitle(result.title, '', '') || (resolveDocTitle('', text, '') ? '' : fileTitle);
        const shownDoc = activeDoc();
        const target = shownDoc && !String(state.files[shownDoc]).trim() ? shownDoc
            : freeDocName(state.mode === 'canvas' ? state.files : null, title || resolveDocTitle('', text, '') || fileTitle);
        if (state.mode !== 'canvas') { state.files = Object.create(null); state.docTitles = Object.create(null); }
        state.files[target] = text;
        state.selectedFile = target;
        state.docTitles[target] = title;
        state.showDiff = false;
        afterFilesChanged('canvas');
        const notes = result.notes && result.notes.length ? ' · ' + result.notes.join(', ') : '';
        flashStatus(`«\u00a0${name}\u00a0» importé${notes}`, '');
    }

    function initDropZone(d) {
        if (!d.panel) return;
        const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
        let depth = 0;
        const blockedText = d.dropOverlay && d.dropOverlay.querySelector('.canvas-drop-blocked');
        const showOverlay = (on) => {
            if (!d.dropOverlay) return;
            d.dropOverlay.hidden = !on;
            d.dropOverlay.classList.toggle('is-blocked', on && !canManageFiles());
            if (blockedText) blockedText.textContent = state.locked ? 'Aperçu\u00a0: lecture seule' : 'Patientez\u00a0: l\'IA est en train de répondre';
        };
        // L'iframe de l'aperçu capterait le glisser (et ouvrirait le fichier) : ignorée le temps du glisser
        document.addEventListener('dragenter', (e) => {
            if (hasFiles(e)) document.body.classList.add('canvas-file-drag');
        });
        const endDrag = () => document.body.classList.remove('canvas-file-drag');
        document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) endDrag(); });
        document.addEventListener('drop', endDrag);
        document.addEventListener('dragend', endDrag);

        d.panel.addEventListener('dragenter', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth++;
            showOverlay(true);
        });
        d.panel.addEventListener('dragover', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = canManageFiles() ? 'copy' : 'none';
        });
        d.panel.addEventListener('dragleave', (e) => {
            if (!hasFiles(e)) return;
            depth = Math.max(0, depth - 1);
            if (!depth) showOverlay(false);
        });
        d.panel.addEventListener('drop', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth = 0;
            showOverlay(false);
            endDrag();
            if (!canManageFiles()) return;
            // Les entrées (dossiers compris) ne sont lisibles que pendant l'événement
            const entries = [];
            for (const item of Array.from(e.dataTransfer.items || [])) {
                const entry = item.kind === 'file' && typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
                if (entry) entries.push(entry);
            }
            const files = Array.from(e.dataTransfer.files || []);
            importFiles(async (report) => entries.length
                ? collectEntries(entries, report)
                : files.map(f => fileSource(f, f.name, true)));
        });
    }

    // ---------- Téléchargement (.zip ou fichier unique) ----------

    /* ZIP sans compression (store only) */
    function buildZip(files) {
        const table = (() => {
            const t = new Uint32Array(256);
            for (let i = 0; i < 256; i++) {
                let c = i;
                for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                t[i] = c >>> 0;
            }
            return t;
        })();
        function crc32(data) {
            let c = 0xFFFFFFFF;
            for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
            return (c ^ 0xFFFFFFFF) >>> 0;
        }
        const encoder = new TextEncoder();
        const parts = [];
        const central = [];
        let offset = 0;

        for (const name of Object.keys(files)) {
            const nameBytes = encoder.encode(name);
            const data = files[name] instanceof Uint8Array ? files[name] : encoder.encode(files[name]);
            const crc = crc32(data);
            const size = data.length;

            // Local file header (30 bytes + name)
            const lfh = new Uint8Array(30 + nameBytes.length);
            const dv = new DataView(lfh.buffer);
            dv.setUint32(0, 0x04034b50, true);          // signature
            dv.setUint16(4, 20, true);                  // version
            dv.setUint16(6, 0x0800, true);              // flags : noms en UTF-8
            dv.setUint16(8, 0, true);                   // compression (store)
            dv.setUint16(10, 0, true);                  // mod time
            dv.setUint16(12, 0, true);                  // mod date
            dv.setUint32(14, crc, true);                // crc32
            dv.setUint32(18, size, true);               // compressed size
            dv.setUint32(22, size, true);               // uncompressed size
            dv.setUint16(26, nameBytes.length, true);   // name length
            dv.setUint16(28, 0, true);                  // extra length
            lfh.set(nameBytes, 30);
            parts.push(lfh);
            parts.push(data);

            // Central directory entry (46 bytes + name)
            const cdh = new Uint8Array(46 + nameBytes.length);
            const dv2 = new DataView(cdh.buffer);
            dv2.setUint32(0, 0x02014b50, true);
            dv2.setUint16(4, 20, true);                 // version made
            dv2.setUint16(6, 20, true);                 // version needed
            dv2.setUint16(8, 0x0800, true);             // flags : noms en UTF-8
            dv2.setUint16(10, 0, true);                 // compression
            dv2.setUint16(12, 0, true);                 // mod time
            dv2.setUint16(14, 0, true);                 // mod date
            dv2.setUint32(16, crc, true);
            dv2.setUint32(20, size, true);
            dv2.setUint32(24, size, true);
            dv2.setUint16(28, nameBytes.length, true);
            dv2.setUint16(30, 0, true);                 // extra
            dv2.setUint16(32, 0, true);                 // comment
            dv2.setUint16(34, 0, true);                 // disk
            dv2.setUint16(36, 0, true);                 // internal attrs
            dv2.setUint32(38, 0, true);                 // external attrs
            dv2.setUint32(42, offset, true);            // local header offset
            cdh.set(nameBytes, 46);
            central.push(cdh);

            offset += lfh.length + data.length;
        }

        // End of central directory
        const cdSize = central.reduce((s, a) => s + a.length, 0);
        const eocd = new Uint8Array(22);
        const dv3 = new DataView(eocd.buffer);
        dv3.setUint32(0, 0x06054b50, true);
        dv3.setUint16(4, 0, true);                      // disk number
        dv3.setUint16(6, 0, true);                      // disk with cd
        dv3.setUint16(8, central.length, true);         // entries on disk
        dv3.setUint16(10, central.length, true);        // total entries
        dv3.setUint32(12, cdSize, true);                // cd size
        dv3.setUint32(16, offset, true);                // cd offset
        dv3.setUint16(20, 0, true);                     // comment length

        return new Blob([...parts, ...central, eocd], { type: 'application/zip' });
    }

    async function downloadFile(name) {
        const base = name.split('/').pop() || name;
        if (name in state.files) {
            const type = mimeOf(name);
            saveBlob(new Blob([state.files[name]], { type: (type === 'application/octet-stream' ? 'text/plain' : type) + ';charset=utf-8' }), base);
            return;
        }
        const blob = state.assets[name] ? await assetBlob(state.assets[name].hash) : null;
        if (blob) saveBlob(blob, base);
        else flashStatus('Fichier introuvable dans le stockage', '', true);
    }

    async function downloadZip() {
        const names = allFileNames();
        if (names.length === 0) return;
        // Canvas : le texte seul, en Markdown (en attendant le menu de la vue texte)
        const doc = activeDoc();
        let blob;
        if (doc) blob = new Blob([state.files[doc]], { type: 'text/markdown;charset=utf-8' });
        else {
            const all = cloneFiles(state.files);
            let missing = 0;
            for (const name of Object.keys(state.assets)) {
                if (all[name] != null) continue;
                const b = await assetBlob(state.assets[name].hash);
                if (b) all[name] = new Uint8Array(await b.arrayBuffer());
                else missing++;
            }
            if (missing) flashStatus(`${plural(missing, 'fichier introuvable', 'fichiers introuvables')} dans le stockage\u00a0: absent${missing > 1 ? 's' : ''} du ZIP`, '', true);
            blob = buildZip(all);
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        let base = doc ? doc.replace(/\.(?:md|markdown)$/i, '') : 'davidtwentyai-artifacts';
        try {
            const title = doc && shownDocTitle() ? shownDocTitle()
                : typeof conversationTitle === 'string' ? conversationTitle : '';
            if (title.trim()) {
                base = title.trim().replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').slice(0, 60).trim() || base;
            }
        } catch (e) { /* titre indisponible */ }
        a.download = base + (doc ? '.md' : '.zip');
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // ---------- Volet : ouverture et fermeture ----------
    // Pendant la fermeture (classe is-closing), le volet est déjà fermé pour le reste de DavidTwentyAI
    const PANEL_SLIDE_MS = 250;
    let panelSlide = null;   // animation en cours : { anim, opening }

    function reducedMotion() {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function panelSlideFrames(panel) {
        const cs = getComputedStyle(panel);
        if (cs.position === 'fixed') {
            const gap = Math.max(0, parseFloat(cs.right) || 0);
            return [{ transform: `translateX(calc(100% + ${gap}px))` }, { transform: 'none' }];
        }
        // Largeur une fois rangé (non rétréci) : son bord gauche part exactement de la bande
        const px = v => parseFloat(v) || 0;
        let w = px(cs.getPropertyValue('--canvas-width')) || panel.getBoundingClientRect().width;
        w = Math.max(px(cs.minWidth), w);
        if (px(cs.maxWidth) > 0) w = Math.min(px(cs.maxWidth), w);
        const rail = px(cs.getPropertyValue('--canvas-rail'));
        const from = { marginLeft: '0px', marginRight: (rail - w) + 'px' };
        const to = { marginLeft: cs.marginLeft, marginRight: cs.marginRight };
        const railBg = cs.getPropertyValue('--canvas-rail-bg').trim();
        if (rail > 0 && railBg) {
            from.backgroundColor = railBg;
            to.backgroundColor = cs.backgroundColor;
        }
        return [from, to];
    }

    /* Une animation en cours repart dans l'autre sens depuis là où elle en est */
    function slidePanel(panel, opening) {
        const running = panelSlide;
        if (running) {
            if (running.opening !== opening) {
                running.opening = opening;
                running.anim.reverse();
            }
            return;
        }
        if (reducedMotion() || typeof panel.animate !== 'function') {
            if (!opening) endHidePanel();
            return;
        }
        const frames = panelSlideFrames(panel);
        const rest = frames[1];
        // Marges qu'il aura à sa place (app.js : partage de la largeur)
        if (rest.marginLeft != null) panel.dataset.restMargins = String((parseFloat(rest.marginLeft) || 0) + (parseFloat(rest.marginRight) || 0));
        // fill both : rien ne bouge entre la fin de l'animation et le volet masqué
        const anim = panel.animate(opening ? frames : frames.slice().reverse(),
            { duration: PANEL_SLIDE_MS, easing: 'ease', fill: 'both' });
        anim.id = 'canvas-slide';
        const slide = panelSlide = { anim, opening };
        anim.onfinish = () => {
            if (panelSlide !== slide) return;
            panelSlide = null;
            if (!slide.opening) endHidePanel();
            delete panel.dataset.restMargins;
            anim.cancel();
        };
    }

    function showPanel() {
        const d = dom();
        if (!d.panel) return;
        const shown = d.panel.style.display === 'flex';
        const closing = d.panel.classList.contains('is-closing');
        d.panel.style.display = 'flex';
        d.panel.classList.remove('is-closing');
        document.body.classList.remove('canvas-closing');
        document.body.classList.add('canvas-active');
        render();
        notifyStateChange();
        // Mesuré après app.js (bande du volet masquée, volet de gauche)
        if (!shown || closing) slidePanel(d.panel, true);
    }

    function setFullscreen(on) {
        const d = dom();
        on = !!on && !!d.panel && d.panel.style.display === 'flex';
        document.body.classList.toggle('canvas-fullscreen', on);
        if (!d.btnFullscreen) return;
        const label = on ? 'Quitter le plein écran' : 'Plein écran';
        d.btnFullscreen.title = label;
        d.btnFullscreen.setAttribute('aria-label', label);
        d.btnFullscreen.setAttribute('aria-pressed', String(on));
    }

    function hidePanel() {
        const d = dom();
        if (!d.panel || d.panel.style.display !== 'flex' || d.panel.classList.contains('is-closing')) return;
        setPreviewTool(null);
        setFullscreen(false);
        setImportMenu(false);
        d.panel.classList.add('is-closing');
        document.body.classList.remove('canvas-active');
        document.body.classList.add('canvas-closing');
        if (d.panel.contains(document.activeElement)) document.activeElement.blur();
        notifyStateChange();
        slidePanel(d.panel, false);
    }

    function endHidePanel() {
        const d = dom();
        if (!d.panel) return;
        d.panel.style.display = 'none';
        d.panel.classList.remove('is-closing');
        // Jamais de plein écran sans volet (la discussion resterait masquée)
        document.body.classList.remove('canvas-fullscreen');
        document.body.classList.remove('canvas-closing');
        // Stoppe l'aperçu s'il tournait (audio, minuteurs, scripts)
        if (previewShowing()) {
            setPreviewLoading(false);
            blankPreview();
            state.previewDirty = true;
        }
        notifyStateChange();
    }

    // Prévient app.js (barre latérale) d'un changement d'état du canvas
    function notifyStateChange() {
        // Les fichiers ou l'espace ont pu changer : frise à recalculer
        if (!state.historyNav) state._timeline = null;
        try { document.dispatchEvent(new CustomEvent('canvas-state-change')); } catch (e) { }
    }

    function isPanelOpen() {
        const d = dom();
        return !!(d.panel && d.panel.style.display === 'flex' && !d.panel.classList.contains('is-closing'));
    }

    // ---------- Activation ----------

    /* Activer n'ouvre pas le volet ; remember : choix mémorisé pour toutes les conversations */
    function setActive(v, remember = true) {
        const wasActive = state.active;
        state.active = !!v;
        state.lastError = null;
        if (remember) {
            try { localStorage.setItem(ENABLED_KEY, state.active ? '1' : '0'); } catch (e) { /* stockage indisponible */ }
        }
        if (!state.active && wasActive && isPanelOpen()) {
            hidePanel();
            return;
        }
        render();
        notifyStateChange();
    }

    function isActive() {
        return state.active;
    }

    // ---------- Serialize / restore ----------

    function serialize(convId) {
        // Première sauvegarde d'une nouvelle conversation : le brouillon du canvas n'a plus lieu d'être
        if (convId && state.convId == null) {
            state.convId = convId;
            clearDraft();
        }
        // Barre d'historique ouverte : on enregistre la version appliquée, pas celle affichée
        const shown = state.historyNav ? state.historyNav.snap : state;
        const shownAssets = shown.assets || state.assets;
        const mode = normalizeMode(shown.mode, shown.files) || (Object.keys(shownAssets).length ? 'artifacts' : null);
        return {
            active: state.active,
            files: cloneFiles(shown.files),
            // Fichiers que l'IA ne lit pas : leur description (contenu à part)
            assets: Object.keys(shownAssets).length ? cloneAssets(shownAssets) : undefined,
            lockedFiles: lockedList(shown.files),
            entrypoint: shown.entrypoint,
            // Espace de la conversation (null : aucun encore) et titre du texte
            mode,
            docTitles: titlesToSave(shown.docTitles, shown.files, mode),
            selectedFile: state.selectedFile,
            pendingErrors: state.opErrors.length ? state.opErrors.slice() : undefined,
            fails: state.failTotal ? { streak: state.failStreak, total: state.failTotal, model: state.failModel } : undefined,
            // Modifications à la main pas encore signalées à l'IA
            aiFiles: filesEqual(state.aiFiles, shown.files) ? undefined : cloneFiles(state.aiFiles),
            // Gros projet : fichiers lus ou modifiés récemment par l'IA
            workingSet: state.workingSet.length ? state.workingSet.map(e => ({ ...e })) : undefined
        };
    }

    /* Nouvelle conversation : canvas vide, volet fermé jusqu'à ce que l'IA écrive dedans */
    function reset(keepPanel) {
        // Frappe non enregistrée : app.js a sauvé la conversation quittée ; ici le brouillon d'une nouvelle
        if (state._saveTimer) {
            clearTimeout(state._saveTimer);
            state._saveTimer = null;
            writeDraft();
        }
        state.editSession = null;
        state.naming = null;
        state._namingRow = null;
        state._editor = null;
        state._statusFlash = null;
        state._docFlash = null;
        if (state._renamingDoc) state._renamingDoc.finish(false);
        if (state._doc) state._doc.closeLayer(true);
        setDownloadMenu(false);
        state.previewHash = '';
        state.previewNav = null;
        state.previewScroll = null;
        if (previewShowing()) {
            setPreviewLoading(false);
            blankPreview();
        }
        resetConsole('');
        state._loadSeq++;
        state.aiFiles = Object.create(null);
        state.workingSet = [];
        state.turnReads = new Set();
        state.promptFull = null;
        state.assets = Object.create(null);
        state.lockedFiles = new Set();
        if (!keepPanel && isPanelOpen()) hidePanel();
        state.active = enabledByDefault();
        state.convId = null;
        state.opErrors = [];
        state.failStreak = 0;
        state.failTotal = 0;
        state.failModel = null;
        state.streamingFile = null;
        state._streamSelectPinned = null;
        state._streamSelectManual = false;
        state.aiWriting = null;
        state.files = Object.create(null);
        state.entrypoint = DEFAULT_ENTRYPOINT;
        state.mode = null;
        state.docTitles = Object.create(null);
        state.versions = [];
        state._timeline = null;
        state.historyNav = null;
        state.previewTool = null;
        state.picked = null;
        hidePickMenu();
        state.selectedFile = null;
        state.lastError = null;
        state.previewDirty = true;
        state.previewCurrentFile = null;
        state.baseline = Object.create(null);
        render();
        notifyStateChange();
    }

    function loadFromConv(data, convId) {
        reset(true);
        state.convId = convId || null;
        if (!data || typeof data !== 'object') data = {};
        if (data.fails && typeof data.fails === 'object') {
            state.failStreak = Number(data.fails.streak) || 0;
            state.failTotal = Number(data.fails.total) || 0;
            state.failModel = data.fails.model || null;
        }
        if (Array.isArray(data.pendingErrors)) {
            state.opErrors = data.pendingErrors.filter(e => typeof e === 'string').slice(-10);
        }
        state.active = enabledByDefault();
        if (data.files && typeof data.files === 'object') {
            for (const k in data.files) {
                if (typeof data.files[k] === 'string') state.files[k] = data.files[k];
            }
        }
        if (data.assets && typeof data.assets === 'object') state.assets = cloneAssets(data.assets);
        state.lockedFiles = readLocked(data.lockedFiles);
        if (data.entrypoint) state.entrypoint = data.entrypoint;
        // Sans mode enregistré (anciennes conversations), déduit des fichiers : un seul .md → Canvas
        state.mode = normalizeMode(data.mode, state.files) || (hasAssets() ? 'artifacts' : null);
        if (data.selectedFile && fileExists(data.selectedFile)) {
            state.selectedFile = data.selectedFile;
        } else {
            state.selectedFile = Object.keys(state.files)[0] || allFileNames()[0] || null;
        }
        state.docTitles = state.mode === 'canvas' ? titlesFrom(data, state.files, state.selectedFile) : Object.create(null);
        // Baseline = état chargé (aucune diff à afficher tant que l'IA n'a pas rejoué)
        state.baseline = cloneFiles(state.files);
        // Fichiers tels que l'IA les connaît (différents s'il y a des
        // modifications à la main pas encore signalées)
        const known = data.aiFiles && typeof data.aiFiles === 'object' ? data.aiFiles : state.files;
        for (const k in known) {
            if (typeof known[k] === 'string') state.aiFiles[k] = known[k];
        }
        if (Array.isArray(data.workingSet)) {
            state.workingSet = data.workingSet
                .filter(e => e && typeof e.name === 'string' && e.name in state.files)
                .map(e => ({ name: e.name, range: validRange(e.range) }))
                .slice(0, WORKING_SET_MAX);
        }
        // Canvas vide : volet fermé, il s'ouvrira quand l'IA écrira dedans
        if (!Object.keys(state.files).length && !hasAssets() && isPanelOpen()) hidePanel();
        pruneAssetCaches();
        render();
        notifyStateChange();
    }

    /* Reprend les fichiers créés ou importés à la main dans une nouvelle conversation jamais envoyée */
    function restoreDraft() {
        const draft = readDraft();
        if (!draft || state.convId != null || Object.keys(state.files).length || hasAssets()) return;
        for (const k in draft.files) {
            if (typeof draft.files[k] === 'string') state.files[k] = draft.files[k];
        }
        if (draft.assets && typeof draft.assets === 'object') state.assets = cloneAssets(draft.assets);
        state.lockedFiles = readLocked(draft.lockedFiles);
        const names = allFileNames();
        if (!names.length) return;
        state.mode = normalizeMode(draft.mode, state.files) || (hasAssets() ? 'artifacts' : null);
        state.selectedFile = names.includes(draft.selectedFile) ? draft.selectedFile : sortFileNames(names)[0];
        state.docTitles = state.mode === 'canvas' ? titlesFrom(draft, state.files, state.selectedFile) : Object.create(null);
        state.baseline = cloneFiles(state.files);
        render();
        notifyStateChange();
    }

    // ---------- Gros projet : plan des fichiers et lecture à la demande ----------
    // Au-delà de FULL_CONTEXT_MAX_TOKENS : liste et plans, l'IA lit les autres par <artifact-read> (continueAfterReads)

    const FULL_CONTEXT_MAX_TOKENS = 25000;
    // Contenu complet envoyé avec la liste (fichiers lus pendant le tour compris)
    const INDEX_FULL_BUDGET_TOKENS = 30000;
    // Fichier (ou partie) jamais envoyé en entier au-delà : l'IA en lit des parties
    const READ_MAX_TOKENS = 30000;
    // Petit fichier, envoyé d'office s'il reste de la place
    const SMALL_FILE_TOKENS = 1200;
    // Fichiers lus ou modifiés par l'IA retenus d'un message à l'autre
    const WORKING_SET_MAX = 12;
    // Plans des fichiers : éléments par fichier, et place totale
    const OUTLINE_MAX_ITEMS = 60;
    const OUTLINE_BUDGET_TOKENS = 8000;

    const fileTokens = text => Math.ceil(String(text || '').length / CHARS_PER_TOKEN);

    function isIndexMode() {
        if (currentMode() !== 'artifacts') return false;
        let n = 0;
        for (const k in state.files) n += fileTokens(state.files[k]);
        return n > FULL_CONTEXT_MAX_TOKENS;
    }

    function validRange(r) {
        if (!r || typeof r !== 'object') return null;
        let from = Math.floor(Number(r.from)), to = Math.floor(Number(r.to));
        if (!(from > 0) || !(to > 0)) return null;
        if (to < from) [from, to] = [to, from];
        return { from, to };
    }

    /** Plage d'une balise de lecture : lines="120-300" (ou 120:300, 120 à 300). */
    function readRangeAttr(attrs) {
        const m = /\b(?:lines?|lignes?)\s*=\s*["']?\s*(\d+)\s*(?:-|–|—|:|\.\.|à|to)\s*(\d+)/i.exec(attrs || '');
        return m ? validRange({ from: m[1], to: m[2] }) : null;
    }

    /** Fichier désigné par l'IA (« ./js/api.js », « API.JS », « api.js ») :
     *  son nom exact dans `files`, ou null. */
    function resolveFileName(raw, files) {
        files = files || state.files;
        const n = normalizePath(raw || '');
        if (!n) return null;
        if (Object.prototype.hasOwnProperty.call(files, n)) return n;
        const names = Object.keys(files);
        const lower = n.toLowerCase();
        const one = list => (list.length === 1 ? list[0] : null);
        return one(names.filter(x => x.toLowerCase() === lower))
            || one(names.filter(x => x.toLowerCase().endsWith('/' + lower) || lower.endsWith('/' + x.toLowerCase())))
            || one(names.filter(x => x.toLowerCase().split('/').pop() === lower.split('/').pop()));
    }

    function sliceLines(text, range) {
        const lines = String(text).split('\n');
        const from = Math.min(Math.max(1, range.from), lines.length);
        const last = Math.min(Math.max(from, range.to), lines.length);
        const maxChars = READ_MAX_TOKENS * CHARS_PER_TOKEN;
        let to = from, chars = lines[from - 1].length;
        while (to < last && chars + 1 + lines[to].length <= maxChars) chars += 1 + lines[to++].length;
        // Une seule ligne déjà trop longue (fichier minifié) : coupée
        if (chars > maxChars) return { text: lines[from - 1].slice(0, maxChars) + '\n[… ligne coupée : trop longue]', range: { from, to } };
        return { text: lines.slice(from - 1, to).join('\n'), range: { from, to } };
    }

    const lineCount = text => String(text).split('\n').length;

    // Déclarations JavaScript, gardées au niveau principal du fichier (voir fileOutline)
    const JS_DECL_RE = /^(\s*)(?:export\s+(?:default\s+)?)?(?:async\s+)?(function\b|class\s+[\w$]|(?:const|let|var)\s+[\w$]+\s*=)/;
    const OUTLINE_PATTERNS = [
        { ext: /^py$/, re: /^(?:\s{0,4})(?:async\s+)?(?:def|class)\s+\w/ },
        { ext: /^(?:md|markdown)$/, re: /^#{1,4}\s+\S/ },
        { ext: /^json$/, re: /^\s{0,2}"[^"]+"\s*:/ },
        { ext: /^php$/, re: /^\s{0,4}(?:(?:public|private|protected|static|abstract|final)\s+)*(?:function|class|interface|trait)\s+\w/ }
    ];
    const _outlineCache = new Map();

    function fileOutline(name, text, max) {
        const cached = _outlineCache.get(name);
        if (cached && cached.max === max && cached.src === text) return cached.items;
        const ext = fileExtension(name);
        const lines = String(text || '').split('\n');
        let items = [];
        const add = (i, s) => {
            s = s.replace(/\s+/g, ' ').trim();
            if (s) items.push(`l.${i + 1} ${s.length > 100 ? s.slice(0, 99) + '…' : s}`);
        };
        const rule = OUTLINE_PATTERNS.find(r => r.ext.test(ext));
        if (/^(?:js|mjs|cjs|ts|jsx|tsx)$/.test(ext)) {
            // Niveau principal : plus petite indentation des fonctions et classes (4 dans un fichier enveloppé)
            let top = Infinity;
            for (const l of lines) {
                const m = JS_DECL_RE.exec(l);
                if (m && !/^(?:const|let|var)/.test(m[2]) && m[1].length < top) top = m[1].length;
            }
            if (top === Infinity) top = 0;
            lines.forEach((l, i) => {
                const m = JS_DECL_RE.exec(l);
                if (m && m[1].length === top) add(i, l.replace(/\s*\{\s*$/, ''));
            });
        } else if (rule) {
            lines.forEach((l, i) => { if (rule.re.test(l)) add(i, l.replace(/\s*\{\s*$/, '')); });
        } else if (/^(?:css|scss|sass|less)$/.test(ext)) {
            // Titres de section (commentaire en début de ligne), sinon sélecteurs
            lines.forEach((l, i) => {
                const m = /^\/\*+\s*(.*?)\s*(?:\*+\/)?\s*$/.exec(l);
                const title = m ? m[1].replace(/^[-=*#~\s]+|[-=*#~\s]+$/g, '') : '';
                if (title && /[\p{L}\d]/u.test(title)) add(i, '/* ' + title + ' */');
            });
            if (items.length < 5) {
                items = [];
                lines.forEach((l, i) => { if (/^(?:@media\b|[^\s@}/][^{;]*\{\s*$)/.test(l)) add(i, l.replace(/\s*\{\s*$/, '')); });
            }
        } else if (/^(?:html?|vue|svelte|xml)$/.test(ext)) {
            lines.forEach((l, i) => {
                const t = /<title>([^<]*)/i.exec(l);
                if (t) return add(i, `<title>${t[1]}</title>`);
                const m = /<(?:h[1-6]|section|main|header|footer|nav|aside|form|dialog|template|script|style)\b[^>]*>/i.exec(l)
                    || /<[a-z][\w-]*\b[^>]*\bid=["'][^"']+["'][^>]*>/i.exec(l);
                if (m) add(i, m[0]);
            });
        }
        if (items.length > max) {
            const total = items.length;
            const picked = [];
            for (let k = 0; k < max; k++) picked.push(items[Math.floor(k * total / max)]);
            picked.push(`… ${total} éléments en tout : lis une partie du fichier pour voir le reste`);
            items = picked;
        }
        _outlineCache.set(name, { src: text, max, items });
        return items;
    }

    /* range : partie lue d'un gros fichier, réunie à la partie déjà lue si elles se touchent */
    function touchWorkingSet(name, range, keepRange) {
        if (!name) return;
        const prev = state.workingSet.find(e => e.name === name);
        let r = validRange(range);
        if (r && prev && prev.range && r.from <= prev.range.to + 40 && prev.range.from <= r.to + 40) {
            r = { from: Math.min(r.from, prev.range.from), to: Math.max(r.to, prev.range.to) };
        }
        if (!r && keepRange && prev && prev.range) r = prev.range;
        state.workingSet = [{ name, range: r }, ...state.workingSet.filter(e => e.name !== name)].slice(0, WORKING_SET_MAX);
    }

    function mentionedFiles(text, names) {
        if (!text) return [];
        const low = String(text).toLowerCase();
        return names.filter(n => {
            const base = n.toLowerCase().split('/').pop();
            if (base.length < 4 || base.indexOf('.') < 0) return false;
            const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp('(?:^|[^\\w./-])(?:' + esc(n.toLowerCase()) + '|' + esc(base) + ')(?![\\w-])').test(low);
        });
    }

    /* « @style.css » vaut seulement si ce nom n'est porté que par un fichier ; envoyés d'office */
    function atMentionedFiles(text, names) {
        if (!text || String(text).indexOf('@') < 0) return [];
        const low = String(text).toLowerCase();
        const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const bases = names.map(n => n.toLowerCase().split('/').pop());
        return names.filter((n, i) => {
            const forms = [n.toLowerCase()];
            if (bases.indexOf(bases[i]) === bases.lastIndexOf(bases[i])) forms.push(bases[i]);
            return forms.some(f => new RegExp('(?:^|[\\s(«"\'\\[{])@' + esc(f) + '(?![\\w/-]|\\.\\w)').test(low));
        });
    }

    /* Priorité : lus et cités avec @, cités, lus récemment, modifiés à la main, affiché, petits */
    function chooseFullFiles(history) {
        const files = state.files;
        const chosen = new Map();
        let budget = INDEX_FULL_BUDGET_TOKENS;
        const take = (n, range, force) => {
            if (!n || !Object.prototype.hasOwnProperty.call(files, n) || chosen.has(n)) return;
            const size = fileTokens(files[n]);
            if (size <= READ_MAX_TOKENS && (!range || size <= 2 * fileTokens(sliceLines(files[n], range).text))) {
                if (!force && size > budget) return;
                chosen.set(n, null);
                budget -= size;
                return;
            }
            // Gros fichier demandé en entier : son début, autant que possible
            if (!range && force) range = { from: 1, to: lineCount(files[n]) };
            if (!range) return;
            const part = sliceLines(files[n], range);
            const t = fileTokens(part.text);
            if (!force && t > budget) return;
            chosen.set(n, part.range);
            budget -= t;
        };
        const ws = state.workingSet.filter(e => e.name in files);
        for (const e of ws) if (state.turnReads.has(e.name)) take(e.name, e.range, true);
        const lastUser = Array.isArray(history) ? history.slice().reverse().find(m => m && m.role === 'user') : null;
        const names = sortFileNames(Object.keys(files));
        const userText = lastUser ? (typeof lastUser.content === 'string' ? lastUser.content
            : Array.isArray(lastUser.content) ? lastUser.content.filter(p => p && p.type === 'text').map(p => p.text).join('\n') : '') : '';
        for (const n of atMentionedFiles(userText, names)) take(n, null, true);
        for (const n of mentionedFiles(userText, names)) take(n, null);
        for (const e of ws) take(e.name, e.range);
        // Pas les fichiers ajoutés : un import en ajoute beaucoup
        const edits = [...(lastUser && Array.isArray(lastUser.canvasEdits) ? lastUser.canvasEdits : []), ...describeManualChanges()];
        for (const e of edits) {
            const m = /^(.*) \((?:modifié|renommé[^)]*)\)$/.exec(e);
            if (m) take(m[1], null);
        }
        take(state.selectedFile, null);
        for (const n of names) if (!/\.svg$/i.test(n) && fileTokens(files[n]) <= SMALL_FILE_TOKENS) take(n, null);
        return chosen;
    }

    function artifactsIndexText(history, tools) {
        const files = state.files;
        const names = sortFileNames(Object.keys(files));
        const chosen = chooseFullFiles(history);
        let max = OUTLINE_MAX_ITEMS, outlines;
        for (;;) {
            outlines = new Map();
            let tokens = 0;
            for (const n of names) {
                if (chosen.get(n) === null) continue;
                const o = max > 0 && !/\.svg$/i.test(n) ? fileOutline(n, files[n], max) : [];
                outlines.set(n, o);
                tokens += fileTokens(o.join('\n'));
            }
            if (tokens <= OUTLINE_BUDGET_TOKENS || max === 0) break;
            max = max > 25 ? 25 : max > 10 ? 10 : 0;
        }
        let bytes = 0;
        const listing = names.map(n => {
            const size = byteSize(files[n]);
            bytes += size;
            const head = `${n} — ${formatSize(size)}, ${plural(lineCount(files[n]), 'ligne', 'lignes')}`;
            const r = chosen.get(n);
            if (r === null) return head + ' : contenu complet plus bas';
            const o = outlines.get(n) || [];
            return head + (r ? ` : lignes ${r.from} à ${r.to} plus bas` : '') + (o.length ? '\n' + o.map(x => '  ' + x).join('\n') : '');
        }).join('\n');
        const contents = [...chosen.keys()].sort((a, b) => names.indexOf(a) - names.indexOf(b)).map(n => {
            const r = chosen.get(n);
            if (!r) return `\n--- ${n} ---\n${files[n]}`;
            return `\n--- ${n} (lignes ${r.from} à ${r.to} sur ${lineCount(files[n])}) ---\n${sliceLines(files[n], r).text}`;
        }).join('\n');
        // Exemples tirés du projet : un fichier pas encore lu, et le plus gros
        const unread = names.filter(n => chosen.get(n) !== null && !/\.svg$/i.test(n));
        const biggest = unread.slice().sort((a, b) => files[b].length - files[a].length)[0];
        const example = unread.find(n => fileTokens(files[n]) <= READ_MAX_TOKENS) || unread[0] || names[0];
        const bigFile = biggest && fileTokens(files[biggest]) > READ_MAX_TOKENS;
        const howToRead = tools ? [
            `Pour lire un fichier, appelle read_file (par exemple name « ${example} ») : son contenu te revient aussitôt.`,
            ...(bigFile ? [`Pour un gros fichier, lis seulement la partie utile, d'après les numéros de ligne de son plan (par exemple name « ${biggest} », from 1, to 200).`] : []),
            '- Lis seulement ce qui est utile à la demande. S\'il t\'en faut plusieurs, appelle read_file pour chacun dans le même tour, tous ensemble : chaque nouvel aller-retour renvoie tout le contexte.',
            '- Pour modifier un fichier, il te faut son texte exact (pour « find » d\'edit_file) : lis d\'abord au moins le passage à changer.',
            '- Ne réécris jamais en entier (write_file) un fichier que tu n\'as pas lu en entier. Pour changer un passage d\'un gros fichier, utilise edit_file.'
        ] : [
            'Pour lire un fichier, écris cette balise, puis arrête ta réponse : DavidTwentyAI t\'envoie aussitôt son contenu, et tu continues.',
            `<artifact-read name="${example}" />`,
            ...(bigFile ? [
                'Pour un gros fichier, lis seulement la partie utile, d\'après les numéros de ligne de son plan :',
                `<artifact-read name="${biggest}" lines="1-200" />`
            ] : []),
            '- Lis seulement ce qui est utile à la demande. S\'il t\'en faut plusieurs, demande-les tous en une seule fois (une balise par fichier, à la suite), puis arrête ta réponse : chaque nouvelle lecture renvoie tout le contexte.',
            '- Pour modifier un fichier, il te faut son texte exact (pour <find>) : lis d\'abord au moins le passage à changer.',
            '- Ne réécris jamais en entier (artifact-file) un fichier que tu n\'as pas lu en entier. Pour changer un passage d\'un gros fichier, utilise <artifact-edit> plutôt qu\'une réécriture complète.'
        ];
        const text = [
            `${plural(names.length, 'fichier', 'fichiers')} (${formatSize(bytes)}), trop pour t'être tous envoyés. Tu as plus bas le contenu complet de certains ; pour les autres, leur plan, avec les numéros de ligne.`,
            '',
            ...howToRead,
            '',
            '--- liste des fichiers ---',
            listing,
            '--- contenu des fichiers ---' + (contents || '\n(aucun pour l\'instant : lis ceux dont tu as besoin)'),
            '--- fin des fichiers ---'
        ].join('\n');
        return { text, full: chosen };
    }

    // ---------- System prompt ----------

    /* inUse (anciennes versions) est ignoré : les consignes ne dépendent que du mode de la conversation */
    function buildSystemPromptSuffix(history, inUse, opts) {
        return buildPromptParts(history, opts).text;
    }

    /* opts.stateOut : l'état est rendu à part (state), qu'app.js place dans un message de l'utilisateur */
    function buildPromptParts(history, opts) {
        // Message envoyé pendant le parcours de l'historique : l'IA travaille sur la version affichée
        if (state.historyNav) closeHistoryNav(true);
        const parts = systemPromptParts(history, opts);
        // Fichiers reçus en entier (gros projet) : refuser la réécriture d'un fichier non lu (null : tous)
        state.promptFull = parts.full ? new Set([...parts.full].filter(([, r]) => r === null).map(([n]) => n)) : null;
        // Erreurs signalées une seule fois : l'IA voit l'état réel juste au-dessus.
        if (state.opErrors.length) state.opErrors = [];
        return { text: parts.text, state: parts.state || '' };
    }

    /* Même texte que buildSystemPromptSuffix, sans ses effets de bord (historique fermé, erreurs vidées) */
    function estimatePromptTokens(history) {
        return Math.round(systemPromptSuffixText(history).length / CHARS_PER_TOKEN);
    }

    function systemPromptSuffixText(history) {
        return systemPromptParts(history).text;
    }
    // (sans stateOut, le texte contient l'état : même taille dans les deux cas)

    /* Sans effet de bord ; pendant le parcours de l'historique, state.files est déjà la version affichée */
    function systemPromptParts(history, opts) {
        const mode = currentMode();
        const tools = !!(opts && opts.tools);
        // État à part (modèles du cloud à outils) : `text` garde les consignes, `state` les fichiers et notes
        const out = !!(opts && opts.stateOut);
        const errors = state.opErrors.map(e => '- ' + e).join('\n');
        if (!mode) {
            const errorsBlock = errors ? '\n\nAttention, ces modifications de ta réponse précédente n\'ont PAS été appliquées :\n' + errors : '';
            const end = '\n' + (tools ? PROMPT_NULL_TOOLS_REMINDER : GUIDE_TAG_NOTE + '\n' + PROMPT_NULL_REMINDER);
            if (out) return { text: (tools ? PROMPT_NULL_TOOLS : PROMPT_NULL) + end, state: errorsBlock.trim(), full: null };
            return { text: (tools ? PROMPT_NULL_TOOLS : PROMPT_NULL) + errorsBlock + end, full: null };
        }
        if (mode === 'canvas') {
            const r = canvasDocPrompt(history, errors, tools, out);
            return typeof r === 'string' ? { text: r, full: null } : { text: r.text, state: r.state, full: null };
        }
        const names = Object.keys(state.files);
        const errorsBlock = errors ? '\n\nAttention, ces modifications de ta réponse précédente n\'ont PAS été appliquées (corrige-les si l\'utilisateur le souhaite, à partir des fichiers ci-dessus) :\n' + errors : '';
        const index = isIndexMode() ? artifactsIndexText(history, tools) : null;
        const stateBlock = '## Fichiers actuels des Artifacts\n' + (index ? index.text
            : names.map(name => `\n--- ${name} ---\n${state.files[name]}`).join('\n') + '\n--- fin des fichiers ---');
        const locked = lockedList(state.files);
        const reminder = (tools
            ? ARTIFACTS_TOOLS_REMINDER + (index ? ' Pour lire un fichier dont tu n\'as que le plan : read_file.' : '')
            : GUIDE_TAG_NOTE + '\n' + (index ? ARTIFACTS_REMINDER + ' Pour lire un fichier dont tu n\'as que le plan : <artifact-read name="…" />.' : ARTIFACTS_REMINDER))
            + (locked && !out ? ' Ne modifie pas les fichiers verrouillés (' + locked.join(', ') + ').' : '');
        const notes = assetsPromptBlock() + lockedPromptBlock() + manualChangesBlock(history, index ? index.full : null) + errorsBlock;
        const instructions = tools ? ARTIFACTS_TOOLS_PROMPT : out ? ARTIFACTS_PROMPT_OUT : ARTIFACTS_PROMPT;
        const full = index ? index.full : null;
        if (out) return { text: instructions + '\n\n' + STATE_NOTES.files + '\n\n' + reminder, state: stateBlock + notes, full };
        return { text: instructions + '\n\n' + stateBlock + notes + '\n\n' + reminder, full };
    }

    /* Réécrire tout le texte seulement si presque tout change : « dans le doute, réécris » faisait perdre des passages */
    /* Plusieurs documents : l'affiché et ceux cités avec « @ » en entier, les autres tant que c'est léger, sinon leur plan */
    const DOCS_FULL_CHARS = 24000;
    const DOC_SMALL_CHARS = 4000;
    function canvasDocsLayout(mentioned) {
        const active = activeDoc();
        const names = docNamesOf(state.files);
        const others = names.filter(n => n !== active);
        const total = names.reduce((t, n) => t + String(state.files[n] || '').length, 0);
        if (total <= DOCS_FULL_CHARS) return { active, full: others, summarized: [] };
        const cited = new Set(mentioned || []);
        const full = [], summarized = [];
        for (const n of others) (cited.has(n) || String(state.files[n] || '').length <= DOC_SMALL_CHARS ? full : summarized).push(n);
        return { active, full, summarized };
    }

    function docOutline(text) {
        const heads = String(text || '').split('\n').filter(l => /^[ \t]{0,3}#{1,6}[ \t]+\S/.test(l)).map(l => l.trim()).slice(0, 40);
        const words = (String(text || '').match(/\S+/g) || []).length;
        const head = heads.length ? heads.join('\n') : String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200) + '…';
        return `${head}\n(${words} mots)`;
    }

    /* Par balises : un titre nouveau crée un document, un passage introuvable est cherché dans les autres */
    function canvasMultiDocPrompt(history, errorsBlock, tools, out) {
        const lay = canvasDocsLayout(atMentionedDocs(lastUserText(history), state.files, state.docTitles));
        const titleOf = n => (docTitleIn(state.files, state.docTitles, n) || 'Sans titre').replace(/"/g, '”');
        const shown = titleOf(lay.active);
        const block = (n, label, body) => ['', `--- document « ${titleOf(n)} »${label} ---`, body, '--- fin du document ---'];
        const activeText = String(state.files[lay.active] || '');
        // État sous son titre, dans les consignes ou à part (`out` : modèle du cloud à outils, voir STATE_NOTES)
        const docsBlock = [
            '', '## Documents actuels du Canvas',
            ...block(lay.active, ' (affiché)', activeText.trim() ? activeText : '(vide)').slice(1),
            ...lay.full.flatMap(n => block(n, '', String(state.files[n] || '').trim() ? state.files[n] : '(vide)')),
            ...lay.summarized.flatMap(n => block(n, tools ? ' (plan seulement : read_document pour le lire)' : ' (plan seulement : pour le modifier, demande à l\'utilisateur de l\'afficher)', docOutline(state.files[n])))
        ];
        if (tools) {
            const rules = [
                // Sans le titre affiché : le prompt système ne change pas d'un onglet à l'autre (cache)
                'Le Canvas, affiché à côté de la conversation, contient plusieurs documents (Markdown) que tu rédiges avec l\'utilisateur ; il voit celui marqué « (affiché) ». Pour les changer, appelle tes outils edit_document et write_document, et create_document pour un nouveau document. Le texte de ta réponse est affiché normalement à l\'utilisateur.',
                'Il ne sert qu\'à ces documents : pour une question, un avis, du code ou un autre texte court, réponds directement, sans outil et sans toucher aux documents.',
                '',
                '## Règles',
                '- Travaille sur le document affiché, sauf si l\'utilisateur parle d\'un autre document : donne alors son titre dans « document ».',
                '- edit_document pour changer un passage : « find » copié exactement du document, assez long pour n\'y être qu\'une fois. Plusieurs passages : un appel par passage, tous ensemble dans la même réponse (chaque nouvel aller-retour renvoie tout le contexte).',
                CANVAS_RULE_KEEP,
                '- write_document pour réécrire tout un document, seulement si presque tout change : le texte complet, sans rien omettre.',
                '- create_document seulement pour un nouveau document que l\'utilisateur demande, jamais pour réécrire un document existant.',
                ...(lay.summarized.length ? ['- Avant de modifier un document dont tu n\'as que le plan, lis-le avec read_document.'] : []),
                '- Chaque outil te répond. Si une modification échoue, corrige-la aussitôt (find exact, ou write_document).',
                '- N\'écris jamais le texte d\'un document dans ta réponse : seuls les outils l\'enregistrent.',
                ...CANVAS_RULES,
                '- Avant d\'appeler tes outils, annonce en une phrase ce que tu vas faire ; une fois les documents modifiés, explique en une ou deux phrases ce que tu as fait.',
                ...(out ? [] : docsBlock)
            ];
            const reminder = '\n\nRappel : edit_document ou write_document pour changer un document (« document » : son titre ; par défaut, le document affiché), create_document pour un nouveau ; jamais leur texte dans ta réponse. Ne supprime rien que l\'utilisateur n\'a pas demandé de supprimer.';
            if (out) return { text: rules.join('\n') + '\n\n' + STATE_NOTES.docs + reminder, state: docsBlock.slice(1).join('\n') + manualChangesBlock(history) + errorsBlock };
            return rules.join('\n') + manualChangesBlock(history) + errorsBlock + reminder;
        }
        const rules = [
            `Le Canvas, affiché à côté de la conversation, contient plusieurs documents (Markdown) que tu rédiges avec l'utilisateur ; il voit ${out ? 'celui marqué « (affiché) »' : `le document « ${shown} »`}. Pour les changer, écris une balise dans ta réponse ; le reste de ta réponse est affiché normalement à l'utilisateur.`,
            'Il ne sert qu\'à ces documents : pour une question, un avis, du code ou un autre texte court, réponds directement dans ta réponse, sans balise et sans toucher aux documents.',
            '',
            'Modifier un passage (texte de <find> copié à l\'identique du document, assez long pour n\'y être qu\'une fois ; plusieurs paires possibles) :',
            `<canvas-doc-edit title="${out ? 'titre du document' : shown}">`,
            '<find>passage actuel exact</find>',
            '<replace>nouveau passage</replace>',
            '</canvas-doc-edit>',
            '',
            'Réécrire tout un document, seulement si presque tout change :',
            `<canvas-doc title="${out ? 'titre du document' : shown}">`,
            'texte complet, sans rien omettre',
            '</canvas-doc>',
            '',
            'Renommer un document, seulement si l\'utilisateur le demande :',
            `<canvas-doc-rename title="${out ? 'titre actuel' : shown}" to="nouveau titre" />`,
            '',
            '## Règles',
            out ? '- title : le titre exact du document à changer (par défaut, le document affiché). Un titre qui n\'est pas dans la liste des documents crée un nouveau document : seulement si l\'utilisateur en demande un.'
                : `- title : le titre exact du document à changer (par défaut, le document affiché, « ${shown} »). Un titre qui n'est pas dans la liste ci-dessous crée un nouveau document : seulement si l'utilisateur en demande un.`,
            '- Ferme toujours tes balises ; jamais de bloc ``` autour.',
            CANVAS_RULE_KEEP,
            ...CANVAS_RULES,
            '- En dehors des balises : une phrase avant, qui annonce ce que tu vas faire, et une ou deux après, qui expliquent ce que tu as fait.',
            out ? CANVAS_RULE_PLACEHOLDER_OUT : CANVAS_RULE_PLACEHOLDER,
            ...(out ? [] : docsBlock)
        ];
        const end = '\n\n' + GUIDE_TAG_NOTE + '\n' + CANVAS_MULTI_REMINDER;
        if (out) return { text: rules.join('\n') + '\n\n' + STATE_NOTES.docs + end, state: docsBlock.slice(1).join('\n') + manualChangesBlock(history) + errorsBlock };
        return rules.join('\n') + manualChangesBlock(history) + errorsBlock + end;
    }

    function canvasDocPrompt(history, errors, tools, out) {
        const doc = activeDoc() || docFileOf(state.files);
        const text = doc ? state.files[doc] : '';
        const title = docTitleIn(state.files, state.docTitles, doc).replace(/"/g, '”');
        const errorsBlock = errors ? '\n\nAttention, ces modifications de ta réponse précédente n\'ont PAS été appliquées (corrige-les si l\'utilisateur le souhaite, à partir du texte ci-dessus) :\n' + errors : '';
        if (docNamesOf(state.files).length > 1) return canvasMultiDocPrompt(history, errorsBlock, tools, out);
        if (!text.trim()) {
            if (out) return { text: canvasDocPrompt(history, '', tools, false), state: errorsBlock.trim() };
            if (tools) {
                return 'Le Canvas, affiché à côté de la conversation, est vide : l\'utilisateur veut y rédiger un texte avec toi. Écris-le en Markdown par un appel de ton outil write_document (titre et texte complet) ; plusieurs textes demandés : un appel par texte, tous dans la même réponse, chacun dans son onglet. N\'écris jamais ce texte dans ta réponse.\n\n' +
                    ['## Règles', ...CANVAS_RULES, '- Avant d\'appeler ton outil, annonce en une phrase ce que tu vas faire ; une fois le texte écrit, explique en une ou deux phrases ce que tu as fait.'].join('\n') + errorsBlock +
                    '\n\nRappel : write_document pour écrire le texte du Canvas ; jamais ce texte dans ta réponse.';
            }
            return 'Le Canvas, affiché à côté de la conversation, est vide : l\'utilisateur veut y rédiger un texte avec toi. Écris-le en Markdown dans <canvas-doc title="Titre du texte">texte complet</canvas-doc> ; plusieurs textes demandés : une balise par texte, chacun dans son onglet.\n\n' +
                ['## Règles', '- Ferme toujours tes balises ; jamais de bloc ``` autour.', ...CANVAS_RULES, '- En dehors des balises : une phrase avant, qui annonce ce que tu vas faire, et une ou deux après, qui expliquent ce que tu as fait.'].join('\n') + errorsBlock + '\n\n' + GUIDE_TAG_NOTE + '\n' + CANVAS_REMINDER;
        }
        const intro = 'Le Canvas, affiché à côté de la conversation, contient ' + (title ? `le texte « ${title} »` : 'un texte') + ' (Markdown) que tu rédiges avec l\'utilisateur.';
        const textBlock = ['', '## Texte actuel du Canvas', '--- texte du Canvas ---', text, '--- fin du texte ---'];
        const stateText = () => textBlock.slice(1).join('\n') + manualChangesBlock(history) + errorsBlock;
        if (tools) {
            const rules = [
                intro + ' Pour le changer, appelle tes outils edit_document et write_document ; pour un autre texte long que l\'utilisateur demande, create_document, qui l\'ouvre dans un nouvel onglet. Le texte de ta réponse est affiché normalement à l\'utilisateur.',
                'Pour une question, un avis, du code ou un texte court, réponds directement, sans outil et sans toucher au texte.',
                '',
                '## Règles',
                '- edit_document pour changer un passage : « find » copié exactement du texte actuel, assez long pour n\'y être qu\'une fois. Plusieurs passages : un appel par passage, tous ensemble dans la même réponse (chaque nouvel aller-retour renvoie tout le contexte).',
                CANVAS_RULE_KEEP,
                '- write_document pour réécrire tout le texte, seulement si presque tout change : le texte complet, sans rien omettre.',
                '- Chaque outil te répond. Si une modification échoue, corrige-la aussitôt (find exact, ou write_document).',
                '- N\'écris jamais le texte du Canvas dans ta réponse : seuls les outils l\'enregistrent.',
                ...CANVAS_RULES,
                '- Avant d\'appeler tes outils, annonce en une phrase ce que tu vas faire ; une fois le texte modifié, explique en une ou deux phrases ce que tu as fait.',
                ...(out ? [] : textBlock)
            ];
            if (out) return { text: rules.join('\n') + '\n\n' + STATE_NOTES.text + '\n\n' + CANVAS_TOOLS_REMINDER, state: stateText() };
            return rules.join('\n') + manualChangesBlock(history) + errorsBlock + '\n\n' + CANVAS_TOOLS_REMINDER;
        }
        const rules = [
            intro + ' Pour le changer, écris une balise dans ta réponse ; le reste de ta réponse est affiché normalement à l\'utilisateur.',
            'Pour un autre texte long que l\'utilisateur demande, écris-le dans <canvas-doc title="son titre"> : un titre nouveau l\'ouvre dans un nouvel onglet, à côté de celui-ci. Pour une question, un avis, du code ou un texte court, réponds directement dans ta réponse, sans balise et sans toucher au texte.',
            '',
            'Modifier un passage (texte de <find> copié à l\'identique du Canvas, assez long pour n\'y être qu\'une fois ; plusieurs paires possibles) :',
            '<canvas-doc-edit>',
            '<find>passage actuel exact</find>',
            '<replace>nouveau passage</replace>',
            '</canvas-doc-edit>',
            '',
            'Réécrire tout le texte, seulement si presque tout change (garde son titre) :',
            `<canvas-doc title="${title || 'Titre du texte'}">`,
            'texte complet, sans rien omettre',
            '</canvas-doc>',
            '',
            'Renommer le texte, seulement si l\'utilisateur le demande :',
            '<canvas-doc-rename to="nouveau titre" />',
            '',
            '## Règles',
            '- Ferme toujours tes balises ; jamais de bloc ``` autour.',
            CANVAS_RULE_KEEP,
            ...CANVAS_RULES,
            '- En dehors des balises : une phrase avant, qui annonce ce que tu vas faire, et une ou deux après, qui expliquent ce que tu as fait.',
            out ? CANVAS_RULE_PLACEHOLDER_OUT : CANVAS_RULE_PLACEHOLDER,
            ...(out ? [] : textBlock)
        ];
        const end = '\n\n' + GUIDE_TAG_NOTE + '\n' + CANVAS_REMINDER;
        if (out) return { text: rules.join('\n') + '\n\n' + STATE_NOTES.text + end, state: stateText() };
        return rules.join('\n') + manualChangesBlock(history) + errorsBlock + end;
    }

    /* Signalés pour que l'IA garde ces modifications au lieu de les prendre pour une erreur à corriger */
    function manualChangesBlock(history, full) {
        const lastUser = Array.isArray(history) ? history.slice().reverse().find(m => m && m.role === 'user') : null;
        const sent = lastUser && Array.isArray(lastUser.canvasEdits) ? lastUser.canvasEdits : [];
        const notes = Array.from(new Set([...sent, ...describeManualChanges()]));
        if (!notes.length) return '';
        if (state.mode === 'canvas') {
            return '\n\nL\'utilisateur a lui-même modifié le texte du Canvas. Le texte ci-dessus est à jour : garde ses modifications.';
        }
        const shown = notes.slice(0, 12);
        const more = notes.length - shown.length;
        return '\n\nL\'utilisateur a lui-même modifié ces fichiers des Artifacts : ' + shown.join(', ')
            + (more > 0 ? `, et ${more} autre${more > 1 ? 's' : ''}` : '')
            // Gros projet (`full`) : seuls certains fichiers sont ci-dessus
            + (full ? '. Ce qui est ci-dessus est à jour (lis les autres avant de les modifier) : garde ses modifications.'
                : '. Leur contenu ci-dessus est à jour : garde ses modifications.');
    }

    // ---------- Échecs successifs ----------

    const MAX_FAIL_STREAK = 2;
    const MAX_FAIL_TOTAL = 4;

    /* → 'ok', 'retry' ou 'stop' (2 échecs d'affilée ou 4 au total) ; compteurs remis à zéro au changement de modèle */
    function recordTurnResult(errorCount, modelId) {
        if (modelId && state.failModel && state.failModel !== modelId) {
            state.failStreak = 0;
            state.failTotal = 0;
        }
        if (!errorCount) {
            state.failStreak = 0;
            return 'ok';
        }
        state.failModel = modelId || null;
        state.failStreak++;
        state.failTotal++;
        return (state.failStreak >= MAX_FAIL_STREAK || state.failTotal >= MAX_FAIL_TOTAL) ? 'stop' : 'retry';
    }

    // ---------- Traitement d'un bloc extrait par le parser ----------

    function handleBlock(block) {
        const result = computeBlock(state.files, block);
        if (result.ok) {
            pushHistory();
            commitResult(state.files, result);
            if (result.content === null) {
                if (state.selectedFile === result.name) state.selectedFile = Object.keys(state.files)[0] || null;
            } else if (!state._streamSelectManual || !fileExists(state.selectedFile)) {
                // Le fichier écrit est affiché, sauf si l'utilisateur en a choisi un autre pendant l'écriture
                state.selectedFile = result.name;
            }
            state.lastError = null;
        } else {
            state.lastError = result.error;
            console.warn('[canvas]', result.error);
        }
        render();
        notifyStateChange();
        return result;
    }

    function rememberOpError(error) {
        state.opErrors.push(error);
        if (state.opErrors.length > 10) state.opErrors.shift();
    }

    // ---------- Init DOM / wiring ----------

    function init() {
        state.active = enabledByDefault();
        const d = dom();
        if (!d.panel) {
            console.warn('[canvas] DOM introuvable, init différée.');
            return;
        }

        if (d.btnToggle) {
            d.btnToggle.addEventListener('click', () => {
                setActive(!state.active);
                if (typeof window.saveConversation === 'function') window.saveConversation();
            });
        }
        if (d.btnClose) {
            d.btnClose.addEventListener('click', hidePanel);
        }
        if (d.tabCode) {
            d.tabCode.addEventListener('click', () => setTab('code'));
        }
        if (d.tabPreview) {
            d.tabPreview.addEventListener('click', () => setTab('preview'));
        }
        if (d.btnRefresh) {
            d.btnRefresh.addEventListener('click', () => {
                state.previewDirty = true;
                refreshPreview();
            });
        }
        if (d.consoleBtn) d.consoleBtn.addEventListener('click', () => setConsoleOpen(!state.consoleOpen));
        if (d.consoleClose) d.consoleClose.addEventListener('click', () => setConsoleOpen(false));
        if (d.consoleClear) d.consoleClear.addEventListener('click', () => resetConsole(state.consolePage));
        if (d.consoleSend) d.consoleSend.addEventListener('click', sendConsoleToAi);
        if (d.diffCheckbox) {
            d.diffCheckbox.addEventListener('change', () => {
                state.showDiff = !!d.diffCheckbox.checked;
                hideDiffHint();
                render();
            });
        }
        if (d.btnDownload) {
            d.btnDownload.addEventListener('click', () => {
                if (displayMode() === 'canvas') setDownloadMenu(!!(d.downloadMenu && d.downloadMenu.hidden));
                else downloadZip();
            });
        }
        if (d.downloadMenu) {
            d.downloadMenu.addEventListener('click', (e) => {
                const item = e.target.closest('[data-format]');
                if (item) downloadDoc(item.dataset.format);
            });
            d.downloadMenu.addEventListener('keydown', (e) => {
                if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                e.preventDefault();
                const items = Array.from(d.downloadMenu.querySelectorAll('button'));
                const i = items.indexOf(document.activeElement);
                items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
            });
            document.addEventListener('mousedown', (e) => {
                if (d.downloadMenu.hidden || d.downloadMenu.contains(e.target) || (d.btnDownload && d.btnDownload.contains(e.target))) return;
                setDownloadMenu(false);
            }, true);
        }
        if (d.docTabs && d.docTabsPrev && d.docTabsNext) {
            d.docTabsPrev.addEventListener('click', () => scrollDocTabs(-1));
            d.docTabsNext.addEventListener('click', () => scrollDocTabs(1));
            d.docTabs.addEventListener('scroll', () => syncDocTabsOverflow(d), { passive: true });
        }
        if (d.codeFileBtn && d.codeView) {
            d.codeFileBtn.addEventListener('click', () => setCodeFilesOpen(!d.codeView.classList.contains('is-files-open')));
            // Clic hors de la liste (menu Importer compris dans la liste) : refermée, sauf nom en cours de saisie
            document.addEventListener('mousedown', (e) => {
                if (!codeFilesMenuShown() || state.naming || d.codeFileBtn.contains(e.target) || (d.sidebar && d.sidebar.contains(e.target))
                    || (d.importMenu && d.importMenu.contains(e.target))) return;
                setCodeFilesOpen(false);
            }, true);
        }
        if (d.previewFileBtn && d.previewMenu) {
            d.previewFileBtn.addEventListener('click', () => setPreviewMenu(d.previewMenu.hidden));
            d.previewMenu.addEventListener('click', (e) => {
                const item = e.target.closest('[data-file]');
                if (item) choosePreviewFile(item.dataset.file);
            });
            d.previewMenu.addEventListener('keydown', (e) => {
                if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                e.preventDefault();
                const items = Array.from(d.previewMenu.querySelectorAll('button'));
                const i = items.indexOf(document.activeElement);
                items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
            });
            document.addEventListener('mousedown', (e) => {
                if (d.previewMenu.hidden || d.previewMenu.contains(e.target) || d.previewFileBtn.contains(e.target)) return;
                setPreviewMenu(false);
            }, true);
            // Clic dans l'aperçu : la page prend le focus, DavidTwentyAI ne voit pas le clic
            window.addEventListener('blur', () => setPreviewMenu(false));
        }
        if (d.btnCopy) d.btnCopy.addEventListener('click', copyDocText);
        if (d.docAddMenu) {
            d.docAddMenu.addEventListener('click', (e) => {
                const item = e.target.closest('[data-add]');
                if (!item) return;
                setDocAddMenu(false);
                if (item.dataset.add === 'import') { if (canManageFiles() && d.docImportInput) d.docImportInput.click(); }
                else newDocument();
            });
            d.docAddMenu.addEventListener('keydown', (e) => {
                if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                e.preventDefault();
                const items = Array.from(d.docAddMenu.querySelectorAll('button'));
                const i = items.indexOf(document.activeElement);
                items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
            });
            document.addEventListener('mousedown', (e) => {
                if (d.docAddMenu.hidden || d.docAddMenu.contains(e.target) || e.target.closest('.canvas-doc-tab-add')) return;
                setDocAddMenu(false);
            }, true);
        }
        if (d.docTitle) d.docTitle.addEventListener('click', startDocRename);
        if (d.docDiffCheckbox) {
            d.docDiffCheckbox.addEventListener('change', () => {
                endEditSession();
                state.showDiff = !!d.docDiffCheckbox.checked;
                hideDiffHint();
                render();
            });
        }
        if (d.emptyNewDoc) d.emptyNewDoc.addEventListener('click', createDoc);
        if (d.emptyNewFile) d.emptyNewFile.addEventListener('click', startNewFile);
        if (d.emptyImport) d.emptyImport.addEventListener('click', () => setImportMenu(!!(d.importMenu && d.importMenu.hidden), d.emptyImport));
        if (d.docImportInput) {
            d.docImportInput.accept = DOC_IMPORT_ACCEPT;
            const pickDoc = () => { if (canManageFiles()) d.docImportInput.click(); };
            if (d.btnImportDoc) d.btnImportDoc.addEventListener('click', pickDoc);
            if (d.emptyImportDoc) d.emptyImportDoc.addEventListener('click', pickDoc);
            d.docImportInput.addEventListener('change', () => {
                const file = d.docImportInput.files && d.docImportInput.files[0];
                // Vidé pour pouvoir réimporter le même fichier
                d.docImportInput.value = '';
                if (file) importDocument(file);
            });
        }
        if (d.emptyState) {
            d.emptyState.addEventListener('click', (e) => {
                const ex = e.target.closest('[data-prompt]');
                if (ex) fillPrompt(ex.dataset.prompt);
            });
        }
        mountDocView(d);
        initResizeHandle(d);
        initHeaderWrap(d);
        applySavedWidth(d);
        // Un second clic sur Historique referme la barre sans appliquer, comme la croix
        if (d.btnHistory) {
            d.btnHistory.addEventListener('click', () => {
                if (state.historyNav) closeHistoryNav(false);
                else openHistoryNav();
            });
        }
        if (d.btnPick) d.btnPick.addEventListener('click', () => setPreviewTool(state.previewTool ? null : 'pick'));
        if (d.pickAskBtn) d.pickAskBtn.addEventListener('click', openPickAsk);
        // Souris sur le menu : rien ne s'allume dessous ; redit à chaque mouvement, la sortie n'étant pas toujours signalée
        if (d.pickMenu) {
            let overRaf = 0;
            const overMenu = () => {
                if (overRaf) return;
                overRaf = requestAnimationFrame(() => { overRaf = 0; postToPreview({ __davidtwentyaiOverMenu: true }); });
            };
            d.pickMenu.addEventListener('mouseenter', overMenu);
            d.pickMenu.addEventListener('mousemove', overMenu);
            d.pickMenu.addEventListener('mouseleave', () => postToPreview({ __davidtwentyaiOverMenu: false }));
        }
        if (d.pickEditBtn) d.pickEditBtn.addEventListener('click', () => {
            if (!state.picked || !state.picked.leaf) return;
            hidePickMenu();
            setPreviewTool('edit');
            postToPreview({ __davidtwentyaiEditPicked: true });
        });
        if (d.pickForm) d.pickForm.addEventListener('submit', (e) => { e.preventDefault(); sendPickAsk(); });
        if (d.pickInput) d.pickInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); d.pickForm.hidden = true; d.pickActions.hidden = false; placePickMenu(); }
        });
        if (d.editDone) d.editDone.addEventListener('click', () => setPreviewTool(null));
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !state.previewTool || e.defaultPrevented) return;
            e.preventDefault();
            if (d.pickMenu && !d.pickMenu.hidden) { hidePickMenu(); postToPreview({ __davidtwentyaiUnpick: true }); return; }
            setPreviewTool(null);
        });
        if (d.btnFullscreen) d.btnFullscreen.addEventListener('click', () => setFullscreen(!document.body.classList.contains('canvas-fullscreen')));
        if (d.historyUndo) d.historyUndo.addEventListener('click', undo);
        if (d.historyRedo) d.historyRedo.addEventListener('click', redo);
        if (d.historyApply) {
            d.historyApply.addEventListener('click', () => {
                closeHistoryNav(true);
                persistNow();
            });
        }
        if (d.historyClose) d.historyClose.addEventListener('click', () => closeHistoryNav(false));
        if (d.btnClear) {
            d.btnClear.addEventListener('click', async () => {
                if (allFileNames().length === 0 || !canManageFiles()) return;
                endEditSession();
                const seq = state._loadSeq;
                const msg = state.mode === 'canvas'
                    ? 'Vider le Canvas\u00a0? Le texte et l\'historique de ses versions seront effacés. La conversation pourra ensuite utiliser les Artifacts ou le Canvas.'
                    : 'Vider les Artifacts\u00a0? Tous les fichiers et l\'historique de leurs versions seront effacés. La conversation pourra ensuite utiliser les Artifacts ou le Canvas.';
                const ok = typeof window.customConfirm === 'function'
                    ? await window.customConfirm(msg, { danger: true, okLabel: 'Vider' })
                    : window.confirm(msg);
                if (!ok || seq !== state._loadSeq || !canManageFiles()) return;
                pushHistory();
                state.files = Object.create(null);
                state.assets = Object.create(null);
                state.lockedFiles = new Set();
                state.selectedFile = null;
                state.previewCurrentFile = null;
                state.previewNav = null;
                afterFilesChanged();
            });
        }

        if (d.btnNew) d.btnNew.addEventListener('click', startNewFile);
        if (d.btnImport && d.importInput) {
            d.btnImport.addEventListener('click', () => setImportMenu(!!(d.importMenu && d.importMenu.hidden), d.btnImport));
            for (const input of [d.importInput, d.importZipInput]) {
                if (!input) continue;
                input.addEventListener('change', () => {
                    const files = Array.from(input.files || []);
                    // Vidé pour pouvoir réimporter le même fichier
                    input.value = '';
                    if (files.length) importFiles(async () => files.map(f => fileSource(f, f.name, true)), true);
                });
            }
            // Dossier : fichiers avec leur chemin (« site/css/style.css »), sans le dossier lui-même, comme glissé
            if (d.importDirInput) {
                d.importDirInput.addEventListener('change', () => {
                    const files = Array.from(d.importDirInput.files || []);
                    d.importDirInput.value = '';
                    if (files.length) importFiles(async () => files.map(f => fileSource(f, f.webkitRelativePath || f.name, false)), true);
                });
            }
        }
        if (d.importMenu) {
            const inputs = { files: d.importInput, dir: d.importDirInput, zip: d.importZipInput };
            d.importMenu.addEventListener('click', (e) => {
                const item = e.target.closest('[data-import]');
                if (!item) return;
                setImportMenu(false);
                const input = inputs[item.dataset.import];
                if (input && canManageFiles()) input.click();
            });
            d.importMenu.addEventListener('keydown', (e) => {
                if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                e.preventDefault();
                const items = Array.from(d.importMenu.querySelectorAll('button'));
                const i = items.indexOf(document.activeElement);
                items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
            });
            document.addEventListener('mousedown', (e) => {
                if (d.importMenu.hidden || d.importMenu.contains(e.target) || (state._importAnchor && state._importAnchor.contains(e.target))) return;
                setImportMenu(false);
            }, true);
        }
        if (d.fileList) {
            d.fileList.addEventListener('click', (e) => {
                const item = e.target.closest('.canvas-file-item');
                if (!item || item.classList.contains('is-naming')) return;
                const name = item.dataset.name;
                const tool = e.target.closest('[data-action]');
                if (!tool) { selectFromList(name); setCodeFilesOpen(false); }
                else if (tool.dataset.action === 'rename') startRename(name);
                else if (tool.dataset.action === 'delete') deleteFile(name);
                else if (tool.dataset.action === 'lock') toggleLock(name);
                else if (tool.dataset.action === 'download') downloadFile(name);
            });
            d.fileList.addEventListener('dblclick', (e) => {
                const item = e.target.closest('.canvas-file-item');
                if (!item || item.classList.contains('is-naming') || e.target.closest('[data-action]')) return;
                if (canManageFiles()) startRename(item.dataset.name);
            });
        }
        if (d.viewerContent) d.viewerContent.addEventListener('mousedown', nudgeReadOnlyHint);
        initDropZone(d);

        // Échap ferme d'abord le calque du volet (en capture) ; jamais pendant une composition IME ni sous un dialogue
        const escapeForPanel = e => e.key === 'Escape' && !e.isComposing && e.keyCode !== 229 && isPanelOpen() && !modalOpen();
        document.addEventListener('keydown', (e) => {
            if (!escapeForPanel(e) || !innerLayerOpen()) return;
            e.preventDefault();
            e.stopPropagation();
            closeInnerLayer();
        }, true);
        document.addEventListener('keydown', (e) => {
            if (!escapeForPanel(e) || e.defaultPrevented) return;
            if (state.historyNav) closeHistoryNav(false);
            else if (document.body.classList.contains('canvas-fullscreen')) setFullscreen(false);
            else hidePanel();
        });

        // Messages de l'iframe d'aperçu : navigation entre les pages HTML (liens, formulaires locaux)
        if (!state._previewMsgListener) {
            state._previewMsgListener = function(ev) {
                const data = ev && ev.data;
                if (!data) return;
                // Seulement notre iframe (affichée ou en chargement) : une autre page ou extension pourrait déclencher une nav
                const dd = dom();
                const back = state._backFrame;
                const fromBack = !!(back && ev.source === back.contentWindow);
                if (!fromBack && (!dd.previewIframe || ev.source !== dd.previewIframe.contentWindow)) return;
                if (data.__davidtwentyaiPreviewReady === true) { onPreviewHostReady(data.v, ev.source); return; }
                // Échap dans l'aperçu (la page avait le clavier) : comme dans DavidTwentyAI
                if (data.__davidtwentyaiEscape === true) {
                    if (fromBack || !state.previewTool) return;
                    const dk = dom();
                    if (dk.pickMenu && !dk.pickMenu.hidden) { hidePickMenu(); postToPreview({ __davidtwentyaiUnpick: true }); }
                    else setPreviewTool(null);
                    return;
                }
                if (data.__davidtwentyaiConsole === true) {
                    // L'ancienne page pendant que la nouvelle se charge : ignorée
                    if (back && !fromBack) return;
                    addConsoleEntry(data.level, data.text, data.where, data.count);
                    return;
                }
                if (data.__davidtwentyaiPreviewLoaded === true) {
                    if (back && !fromBack) return;
                    setPreviewLoading(false);
                    if (fromBack) swapPreviewFrames();
                    // Nouvelle page : l'outil en cours (sélection, textes) continue
                    if (state.previewTool) { hidePickMenu(); postToPreview({ __davidtwentyaiTool: state.previewTool }); }
                    return;
                }
                if (data.__davidtwentyaiScroll === true) {
                    if (!back && Number.isFinite(data.x) && Number.isFinite(data.y)) {
                        state.previewScroll = { page: state.previewCurrentFile, x: data.x, y: data.y };
                    }
                    return;
                }
                if (data.__davidtwentyaiFile === true) { answerPreviewFile(ev.source, data); return; }
                // Outils de l'aperçu (élément choisi, texte changé) : page affichée seulement
                if (back && !fromBack && (data.__davidtwentyaiPicked || data.__davidtwentyaiTextEdit)) return;
                // L'aperçu est revenu au choix d'un élément (clic hors du texte) : DavidTwentyAI suit, sans le lui renvoyer
                if (data.__davidtwentyaiToolChanged === 'pick') {
                    if (fromBack || state.previewTool !== 'edit') return;
                    state.previewTool = 'pick';
                    renderPreviewTools(dom());
                    return;
                }
                if (data.__davidtwentyaiPicked === true) { if (state.previewTool === 'pick') showPickMenu(data); return; }
                if (data.__davidtwentyaiEditRefused === true) { setEditBanner(`« ${data.label} » contient d'autres éléments : cliquez sur un texte plus précis.`, 'error'); return; }
                if (data.__davidtwentyaiEditing === true) { setEditBanner(`Modification de « ${data.label} » : Entrée pour valider, Échap pour annuler.`); return; }
                if (data.__davidtwentyaiTextEdit === true) { if (state.previewTool === 'edit') applyPreviewTextEdit(data); return; }
                if (data.__canvasNav !== true || typeof data.href !== 'string') return;
                const hashAt = data.href.indexOf('#');
                const clean = data.href.split('#')[0].split('?')[0];
                if (!clean) return;
                const resolved = resolvePath(clean, state.previewCurrentFile);
                if (!resolved) {
                    addConsoleEntry('warn', 'Lien vers un fichier absent des Artifacts : ' + data.href, '');
                    return;
                }
                state.previewCurrentFile = resolved;
                state.previewNav = { from: state.selectedFile, page: resolved };
                state.previewHash = hashAt >= 0 ? data.href.slice(hashAt + 1) : '';
                state.previewDirty = true;
                refreshPreview();
                renderPreviewBar(dom());
            };
            window.addEventListener('message', state._previewMsgListener);
        }

        render();
        restoreDraft();
    }

    // ---------- Redimensionnement ----------

    function applySavedWidth(d) {
        if (!d || !d.panel) return;
        let saved = parseInt(localStorage.getItem(WIDTH_STORAGE_KEY), 10);
        if (!Number.isFinite(saved) || saved < MIN_WIDTH) saved = DEFAULT_WIDTH;
        const maxW = Math.max(MIN_WIDTH, Math.floor(window.innerWidth * 0.9));
        if (saved > maxW) saved = maxW;
        d.panel.style.setProperty('--canvas-width', saved + 'px');
    }

    /* Volet étroit : boutons de l'en-tête sous les onglets, sur toute la largeur (is-wrapped, style.css) */
    function initHeaderWrap(d) {
        const header = d.panel && d.panel.querySelector('.canvas-header');
        const actions = header && header.querySelector('.canvas-header-actions');
        if (!header || !actions || typeof ResizeObserver !== 'function') return;
        const update = () => {
            const first = header.firstElementChild;
            const wrapped = !!first && first !== actions && actions.offsetTop > first.offsetTop + first.offsetHeight / 2;
            header.classList.toggle('is-wrapped', wrapped);
        };
        new ResizeObserver(update).observe(header);
    }

    function initResizeHandle(d) {
        if (!d || !d.resizeHandle || !d.panel) return;
        const handle = d.resizeHandle;
        let dragging = false;
        let startX = 0;
        let startWidth = 0;

        function onMouseMove(e) {
            if (!dragging) return;
            // La poignée est à gauche du volet → déplacer vers la gauche agrandit
            const delta = startX - e.clientX;
            const maxW = Math.max(MIN_WIDTH, Math.floor(window.innerWidth * 0.9));
            let w = startWidth + delta;
            if (w < MIN_WIDTH) w = MIN_WIDTH;
            if (w > maxW) w = maxW;
            d.panel.style.setProperty('--canvas-width', w + 'px');
            // Étiré au-delà de la place, il replie le volet de gauche ; ramené, il le fait revenir (app.js)
            try { document.dispatchEvent(new CustomEvent('canvas-resize-drag')); } catch (err) { }
        }

        function onMouseUp() {
            if (!dragging) return;
            dragging = false;
            document.body.classList.remove('canvas-resizing');
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            const cs = getComputedStyle(d.panel);
            const currentW = parseInt(cs.width, 10);
            if (Number.isFinite(currentW)) {
                try { localStorage.setItem(WIDTH_STORAGE_KEY, String(currentW)); } catch (e) { /* quota */ }
                d.panel.style.setProperty('--canvas-width', currentW + 'px');
            }
            // Le volet de gauche peut revenir si le canvas a rétréci (app.js)
            notifyStateChange();
        }

        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            dragging = true;
            startX = e.clientX;
            startWidth = d.panel.getBoundingClientRect().width;
            document.body.classList.add('canvas-resizing');
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        window.addEventListener('resize', () => {
            const maxW = Math.max(MIN_WIDTH, Math.floor(window.innerWidth * 0.9));
            const cur = parseInt(getComputedStyle(d.panel).getPropertyValue('--canvas-width'), 10);
            if (Number.isFinite(cur) && cur > maxW) {
                d.panel.style.setProperty('--canvas-width', maxW + 'px');
            }
        });
    }

    // ---------- API publique ----------

    window.Canvas = {
        init,
        /** Nouvelle conversation (avec le brouillon d'une précédente jamais envoyée). */
        reset(keepPanel) {
            reset(keepPanel);
            restoreDraft();
            pruneAssetCaches();
        },
        loadFromConv,
        serialize,

        isActive,
        setActive,

        /* Les fichiers lus pendant la réponse précédente ne partent plus d'office (gros projet, voir chooseFullFiles) */
        beginTurn() {
            state.turnReads = new Set();
        },

        /* Empreintes des fichiers non lus utilisées ou enregistrées cette session : jamais retirées par gcCanvasAssets */
        assetHashesInUse() {
            const out = new Set(recentAssetHashes);
            const add = (assets) => { for (const k in assets || {}) if (assets[k] && assets[k].hash) out.add(assets[k].hash); };
            add(state.assets);
            for (const v of state.versions) add(v && v.assets);
            if (state.historyNav) {
                add(state.historyNav.snap && state.historyNav.snap.assets);
                for (const snap of state.historyNav.list) add(snap && snap.assets);
            }
            return [...out];
        },

        /* Fichiers citables avec « @ » : [{ name, size, icon }], dans l'ordre de la liste */
        mentionableFiles() {
            if (!state.active || state.locked) return [];
            if (currentMode() === 'canvas') {
                // Seul document aussi : déjà envoyé en entier, la mention ne l'envoie pas une seconde fois
                const docs = docNamesOf(state.files);
                return docs.map(name => {
                    const words = (String(state.files[name] || '').match(/\S+/g) || []).length;
                    return { name, label: docTitleIn(state.files, state.docTitles, name) || 'Sans titre', doc: true, asset: false,
                        size: words ? `${words} mot${words > 1 ? 's' : ''}` : 'vide', icon: iconForFile(name) };
                });
            }
            if (currentMode() !== 'artifacts') return [];
            // Fichiers que l'IA ne lit pas : cités quand même (elle sait qu'ils existent)
            return sortFileNames(allFileNames()).map(name => {
                const asset = !(name in state.files);
                return { name, asset, size: formatSize(asset ? state.assets[name].size : byteSize(state.files[name])), icon: iconForFile(name) };
            });
        },

        /* Documents cités avec « @ » dans `text` : [{ start, end, name, label }], pour les pastilles */
        docMentions(text) {
            if (!state.active || currentMode() !== 'canvas' || docNamesOf(state.files).length < 2) return [];
            return docMentionRanges(text, state.files, state.docTitles)
                .map(r => ({ ...r, label: docTitleIn(state.files, state.docTitles, r.name) || 'Sans titre' }));
        },

        /* Aperçu depuis le gestionnaire de stockage (app.js) : rien n'est modifiable ni demandé à l'IA */
        setLocked(locked) {
            locked = !!locked;
            if (state.locked === locked) return;
            state.locked = locked;
            if (locked) {
                if (state.historyNav) closeHistoryNav(false);
                endEditSession();
                state.naming = null;
                state._namingRow = null;
                if (state._renamingDoc) state._renamingDoc.finish(false);
                if (state._doc) state._doc.closeLayer(true);
                setDownloadMenu(false);
                setDocAddMenu(false);
            }
            render();
        },

        /* Réponse de l'IA en cours dans la conversation affichée : canvas en lecture seule */
        setBusy(busy) {
            busy = !!busy;
            if (state.busy === busy) return;
            state.busy = busy;
            if (busy) {
                // Version affichée pendant l'envoi : l'IA travaille sur elle
                if (state.historyNav) closeHistoryNav(true);
                setPreviewTool(null);
                endEditSession();
                state.naming = null;
                state._namingRow = null;
            } else {
                // Réponse arrêtée ou en erreur : plus rien en cours d'écriture
                state.aiWriting = null;
            }
            render();
        },

        /* Modifications manuelles depuis que l'IA a vu le canvas (jointes au message, pour les relances), ensuite connues */
        takeManualChanges() {
            if (state.historyNav) closeHistoryNav(true);
            endEditSession();
            const changes = describeManualChanges();
            state.aiFiles = cloneFiles(state.files);
            return changes;
        },

        hasManualChanges() {
            return describeManualChanges().length > 0;
        },

        /* opts : convId, isStreamForeground, onPersist, onBackgroundPersist, onOperation, focus, userText, appendDoc */
        createStreamParser(opts) {
            opts = opts || {};
            if (state.historyNav) closeHistoryNav(true);
            // Modification à la main en cours terminée : la copie de travail du tour part de l'état actuel
            endEditSession();
            const convId = opts.convId || null;
            // Une nouvelle conversation reçoit son ID au premier envoi : le canvas affiché lui appartient
            if (convId && state.convId == null) {
                state.convId = convId;
                clearDraft();
            }
            // Copie de travail à jour même hors affichage ; son `mode` est fixé par le premier bloc réussi
            const work = {
                files: cloneFiles(state.files),
                entrypoint: state.entrypoint,
                selectedFile: state.selectedFile,
                // Échecs du tour précédent déjà signalés dans ce prompt : la copie de travail repart de zéro
                opErrors: [],
                mode: currentMode(),
                docTitles: cloneTitles(state.docTitles),
                // Fichiers non lus et verrouillés : fixés pour le tour
                assets: cloneAssets(state.assets),
                locked: new Set([...state.lockedFiles].filter(n => n in state.files))
            };
            // État avant ce tour (pour la régénération) : les fichiers, leur espace et le titre
            const turnBaseline = cloneFiles(work.files);
            const assetsMeta = a => (Object.keys(a || {}).length ? cloneAssets(a) : undefined);
            const turnBaselineMeta = { mode: work.mode, docTitles: titlesToSave(work.docTitles, work.files, work.mode), selectedFile: work.selectedFile, assets: assetsMeta(work.assets) };
            // Échecs de ce tour (renvoyés automatiquement à l'IA par app.js)
            const turnErrors = [];
            let wasShown = true;
            const isShown = () => !convId || state.convId === convId;
            // Retour sur la conversation en génération : l'état chargé du disque peut être en retard, on le resynchronise
            const syncIfBack = () => {
                const shown = isShown();
                if (shown && !wasShown) {
                    state.files = cloneFiles(work.files);
                    state.aiFiles = cloneFiles(work.files);
                    state.opErrors = work.opErrors.slice();
                    state.mode = work.mode;
                    state.docTitles = cloneTitles(work.docTitles);
                    state.previewDirty = true;
                }
                wasShown = shown;
                return shown;
            };
            // Tolérances du texte du Canvas (voir computeDocBlock)
            const docCtx = {
                focus: opts.focus && typeof opts.focus.excerpt === 'string' && opts.focus.excerpt ? opts.focus : null,
                userText: typeof opts.userText === 'string' ? opts.userText : '',
                appendDoc: !!opts.appendDoc,
                mode: null
            };
            // Tour commencé sans texte au Canvas : un titre nouveau est un texte de plus (« écris-moi trois lettres »)
            const startedEmpty = work.mode !== 'artifacts' && !docNamesOf(work.files).some(n => String(work.files[n] || '').trim());
            // Canvas demandé par l'utilisateur : même un texte court l'ouvre
            const userAsksCanvas = /canvas/i.test(docCtx.userText);
            // Question sur du code : une page écrite en réponse est un exemple, rendu dans la réponse
            const userAsksQuestion = askKind(docCtx.userText) === 'question';
            // Famille d'une balise de fichier et nom du texte, selon l'espace de CE tour (voir matchOpenTag)
            const dialect = {
                familyOf(type, name) {
                    if (name && !TEXT_FILE_RE.test(name)) return 'artifacts';
                    return work.mode === 'artifacts' ? 'artifacts' : 'canvas';
                },
                /* Texte visé (target, title, passage choisi, seul cité « @ », affiché) ; dès deux textes, un titre nouveau en crée un */
                docName(title, name, target, kind) {
                    if (work.mode === 'canvas' && docNamesOf(work.files).length) {
                        if (target) return docByTitle(work.files, work.docTitles, target);
                        const same = title ? docByTitle(work.files, work.docTitles, title) : null;
                        if (same) return same;
                        if (kind === 'file' && title && !docCtx.focus && docNamesOf(work.files).length > 1) return freeDocName(work.files, title);
                        const focusDoc = docCtx.focus && docCtx.focus.docName && docCtx.focus.docName in work.files ? docCtx.focus.docName : null;
                        const cited = atMentionedDocs(docCtx.userText, work.files, work.docTitles);
                        const doc = focusDoc || (cited.length === 1 ? cited[0] : null) || activeDocOf(work.files, work.selectedFile);
                        // Balise <canvas-doc> au titre nouveau sur le seul texte : un autre texte, comme avec plusieurs documents
                        if ((startedEmpty || kind === 'file') && title && !docCtx.focus && doc && String(work.files[doc] || '').trim()) return freeDocName(work.files, title);
                        return doc;
                    }
                    if (title) return docNameFromTitle(title);
                    if (name && TEXT_FILE_RE.test(name)) return normalizePath(name).split('/').pop().replace(/\.txt$/i, '.md') || 'document.md';
                    return 'document.md';
                }
            };
            /* → 'apply', 'demote' (rendu dans la réponse, sans relance), 'wait' (trop court pour juger) ou { error } */
            const routeBlock = (block, inProgress) => {
                const family = block.family === 'canvas' ? 'canvas' : 'artifacts';
                if (!work.mode) {
                    if (family !== 'canvas') return userAsksQuestion && block.kind === 'file' ? 'demote' : 'apply';
                    if (block.kind !== 'file') return { error: DOC_ERRORS.empty };
                    // (un texte coupé était parti pour être long : il est gardé)
                    if (!userAsksCanvas && !(block.payload && block.payload.partial)
                        && docBodyLength(block.payload && block.payload.content) < SHORT_DOC_CHARS) return inProgress ? 'wait' : 'demote';
                    return 'apply';
                }
                if (family === work.mode) return 'apply';
                if (block.kind === 'file') return 'demote';
                return { error: ROUTE_ERRORS[work.mode] };
            };
            /* Balise sans nom hors Artifacts : au Canvas, sauf du code qui devient un fichier Artifacts au nom déduit */
            /* Plusieurs textes : un passage introuvable dans le texte visé mais trouvé dans un seul autre va à celui-ci */
            const retargetDocEdit = (block) => {
                if (block.family !== 'canvas' || block.kind !== 'edit' || block.viaTool || docCtx.focus || work.mode !== 'canvas' || docNamesOf(work.files).length < 2) return block;
                const name = block.payload && block.payload.name;
                const ctx = { ...docCtx, mode: work.mode, turnWritten: 0, appendDoc: false };
                const fits = n => computeDocBlock(work.files, { ...block, payload: { ...block.payload, name: n } }, ctx).ok;
                if (name && name in work.files && fits(name)) return block;
                const hits = docNamesOf(work.files).filter(n => n !== name && fits(n));
                return hits.length === 1 ? { ...block, payload: { ...block.payload, name: hits[0] } } : block;
            };
            const codeFileOf = (block, partial) => {
                if (block.family !== 'canvas' || block.kind !== 'file' || block.tag !== 'file' || block.rawName) return block;
                const body = String(block.payload && block.payload.content || '');
                let name = guessCodeName(body);
                if (!name && partial) {
                    const head = body.trim();
                    if (/^<(?:!doctype|html|head|body|!--|meta|link|style|script|div|main|section|h1)\b/i.test(head)) name = 'index.html';
                    else if (head.length < 60 && (!head.length || /[{};<>=()]/.test(head) || /^(?:@|:root|[.#*\w-]+\s*[{,])|^(?:function|const|let|var|import|document|window)\b/.test(head))) return 'wait';
                }
                if (!name) return block;
                return { ...block, family: 'artifacts', payload: { ...block.payload, name } };
            };
            // Texte écrit par une réécriture complète de ce tour (une seconde bien plus courte est une coquille : computeDocBlock)
            docCtx.turnWritten = 0;
            // Longueur écrite par une réécriture de ce tour, par texte
            docCtx.writtenBy = Object.create(null);
            // État avant ce tour, pour « Afficher les modifications » (la suite d'une réponse coupée garde celui du début)
            if (!opts.keepBaseline) captureBaseline();
            const operations = [];
            // Lectures demandées (gros projet) : { name, exists, range, again } ; fichiers écrits pendant ce tour
            const reads = [];
            let guideAsked = false;
            const written = new Set();
            // Fichiers dont une modification a échoué dans ce tour
            const failedNames = new Set();
            // Blocs rendus dans la réponse au lieu d'être appliqués
            const demoted = new Set();
            // Balises recopiées de l'historique avec leur contenu de remplacement
            let placeholderCopies = 0;
            let placeholderFamily = 'artifacts';
            // Même fichier que le badge juste avant, rien entre les deux : pas de second badge (opts.lastBadge : suite d'une réponse coupée)
            const repeatsBadge = key => {
                const last = parser.lastBadgeKey();
                return (last === undefined ? opts.lastBadge || null : last) === key;
            };
            // Fichiers dont ce tour a montré un badge de création ou de modification
            const shownNames = new Set();
            // Le volet s'ouvre une fois par tour quand l'IA écrit dedans : refermé pendant la réponse, il le reste
            let opened = false;
            // Ouvert par ce tour (pas déjà ouvert par l'utilisateur) : refermé s'il reste vide après un arrêt
            let shownByTurn = false;
            const openPanel = () => {
                if (opened) return;
                opened = true;
                if (!isPanelOpen()) { showPanel(); shownByTurn = true; }
            };
            const persist = () => {
                const fg = typeof opts.isStreamForeground === 'function' ? opts.isStreamForeground() : true;
                try {
                    if (fg) {
                        if (typeof opts.onPersist === 'function') opts.onPersist();
                    } else if (typeof opts.onBackgroundPersist === 'function') {
                        const mode = normalizeMode(work.mode, work.files);
                        opts.onBackgroundPersist({
                            active: true,
                            files: cloneFiles(work.files),
                            // Sans eux, l'enregistrement en arrière-plan perdrait les fichiers grisés et les verrous
                            assets: Object.keys(work.assets).length ? cloneAssets(work.assets) : undefined,
                            lockedFiles: (l => l.length ? l : undefined)([...work.locked].filter(n => n in work.files)),
                            entrypoint: work.entrypoint,
                            mode,
                            docTitles: titlesToSave(work.docTitles, work.files, mode),
                            selectedFile: work.selectedFile in work.files ? work.selectedFile : (Object.keys(work.files)[0] || null),
                            pendingErrors: work.opErrors.slice()
                        });
                    }
                } catch (e) { console.error(e); }
            };
            const parser = createStreamParser(
                (block) => {
                const shown = syncIfBack();
                if (!work.mode || work.mode === 'canvas') block = retargetDocEdit(codeFileOf(block, false));
                // <artifact-file> contenant <find>/<replace> (petits modèles) : modification ciblée, pas un nouveau contenu
                if (block.kind === 'file' && block.family !== 'canvas' && block.payload && typeof block.payload.content === 'string'
                    && /<find>[\s\S]*?<\/find>[\s\S]*?<replace>/i.test(block.payload.content)) {
                    const asEdit = editBlock(block.payload.name, block.payload.content, 'artifacts');
                    if (asEdit.kind === 'edit') block = { ...asEdit, viaTool: block.viaTool };
                }
                // Nom sans dossier (« style.css ») : résolu pour une modification (le « find » la garde), exact pour une suppression
                if ((block.kind === 'edit' || block.kind === 'delete') && block.family !== 'canvas' && block.payload
                    && typeof block.payload.name === 'string' && block.payload.name && !(block.payload.name in work.files)
                    && !(work.assets && Object.prototype.hasOwnProperty.call(work.assets, block.payload.name))) {
                    const sameName = () => {
                        const n = normalizePath(block.payload.name).toLowerCase();
                        const hits = n ? Object.keys(work.files).filter(x => x.toLowerCase() === n) : [];
                        return hits.length === 1 ? hits[0] : null;
                    };
                    const real = block.kind === 'delete' ? sameName() : resolveFileName(block.payload.name, work.files);
                    if (real) block = { ...block, payload: { ...block.payload, name: real } };
                }
                const name = block.payload && typeof block.payload.name === 'string' ? block.payload.name : null;
                const family = block.family === 'canvas' ? 'canvas' : 'artifacts';
                const endStreaming = () => {
                    if (shown && state.streamingFile && state.streamingFile.name === name) {
                        state.streamingFile = null;
                        state._streamSelectPinned = null;
                        state._streamSelectManual = false;
                        render();
                    }
                };
                // Guide demandé par la balise : rien d'affiché ; la suite de la réponse le recevra (continueAfterReads)
                if (block.kind === 'guide') { guideAsked = true; return ''; }
                // Renommage par balise : seul le titre change, comme un double-clic sur l'onglet
                if (block.kind === 'rename') {
                    const to = resolveDocTitle(block.payload.title || '', '', '').slice(0, 200);
                    if (work.mode !== 'canvas' || !name || !(name in work.files) || !to) {
                        const error = !to ? '<canvas-doc-rename> sans nouveau titre (to="…") : rien n\'a été renommé'
                            : block.payload.from ? `<canvas-doc-rename> : aucun document « ${block.payload.from} » dans le Canvas : rien n'a été renommé`
                            : '<canvas-doc-rename> : le Canvas n\'a pas de texte à renommer';
                        turnErrors.push(error);
                        work.opErrors.push(error);
                        if (shown) rememberOpError(error);
                        return { html: buildInlineErrorMarker('Renommage non appliqué', 'canvas'), always: true };
                    }
                    // Titre déjà celui-là : pas de badge « Titre changé »
                    if ((work.docTitles[name] || '') === to) return '';
                    work.docTitles[name] = to;
                    operations.push({ kind: 'rename', name, before: work.files[name], after: work.files[name] });
                    if (shown) { state.docTitles = cloneTitles(work.docTitles); render(); notifyStateChange(); }
                    persist();
                    return { html: buildInlineRenameMarker(name, to), always: true };
                }
                // Lecture (gros projet, Artifacts seulement) : rien ne change ; la suite le recevra (continueAfterReads)
                if (block.kind === 'read') {
                    if (work.mode !== 'artifacts' || !name) return '';
                    const real = resolveFileName(name, work.files);
                    const range = validRange(block.payload.range);
                    // Fichier que l'IA ne lit pas (image, minifié…) : signalé
                    const unread = !real ? resolveFileName(name, work.assets) : null;
                    if (unread) {
                        reads.push({ name: unread, exists: true, unreadable: true, range: null, again: false });
                        return { html: buildInlineErrorMarker(`Lecture impossible : ${unread} n'est pas lisible par l'IA (${assetKindLabel(unread, work.assets[unread].type)})`, 'artifacts'), always: true };
                    }
                    // Déjà envoyé en entier (lu pendant ce tour, ou dans le prompt)
                    const again = !!real && !range && (state.turnReads.has(real) || !state.promptFull || state.promptFull.has(real));
                    reads.push({ name: real || name, exists: !!real, range, again });
                    if (real && shown) {
                        touchWorkingSet(real, range);
                        state.turnReads.add(real);
                    }
                    return { html: buildInlineReadMarker(real || name, range, !!real), always: true };
                }
                // Fichier que l'IA ne lit pas (image, minifié…) : ni réécrit, ni modifié, ni supprimé
                if (family === 'artifacts' && name && work.files[name] == null && work.assets[name]
                    && (block.kind === 'file' || block.kind === 'edit' || block.kind === 'edit-loose' || block.kind === 'delete')) {
                    endStreaming();
                    const error = `« ${name} » est un fichier que tu ne peux ni lire ni modifier (${assetKindLabel(name, work.assets[name].type)}) : il n'a pas été changé`;
                    turnErrors.push(error);
                    work.opErrors.push(error);
                    if (shown) { state.lastError = error; rememberOpError(error); }
                    return { html: buildInlineErrorMarker(`${name} non modifiable par l'IA`, 'artifacts'), always: true };
                }
                // Fichier verrouillé : refusé sans relance (l'IA n'y peut rien) ; elle en est avertie au message suivant
                if (family === 'artifacts' && name && work.locked.has(name) && name in work.files && block.kind !== 'read') {
                    endStreaming();
                    const error = `« ${name} » est verrouillé par l'utilisateur : ta modification a été refusée. Ne le modifie pas ; propose une autre solution, ou demande-lui de le déverrouiller`;
                    work.opErrors.push(error);
                    if (work.opErrors.length > 10) work.opErrors.shift();
                    if (shown) rememberOpError(error);
                    return { html: buildInlineErrorMarker(`${name} est verrouillé : non modifié`, 'artifacts'), always: true };
                }
                // Balise recopiée de l'historique avec son contenu de remplacement : ignorée
                if ((block.kind === 'file' || block.kind === 'edit-loose' || block.kind === 'edit-replace') && PLACEHOLDER_RE.test((block.payload.content || '').trim())) {
                    placeholderCopies++;
                    placeholderFamily = family;
                    endStreaming();
                    return '';
                }
                // Création dans l'autre espace : rendue dans la réponse, sans erreur ni relance
                const route = routeBlock(block, false);
                if (route === 'demote') {
                    if (name) demoted.add(name);
                    endStreaming();
                    const html = demotedBlockText(block);
                    return html ? { html, always: true } : '';
                }
                // Artifacts affichés sur l'aperçu : le volet ne s'ouvre qu'à la fin du tour
                if (shown && route === 'apply') {
                    if (state.mode === 'artifacts' && state.activeTab === 'preview') state.aiWriting = name || state.aiWriting;
                    else openPanel();
                }
                const existedBefore = !!name && Object.prototype.hasOwnProperty.call(work.files, name);
                const before = existedBefore ? work.files[name] : null;
                // Texte du Canvas ramené au texte complet, appliqué tel quel sur la copie de travail puis l'état affiché
                let applied = block;
                let result;
                if (route !== 'apply') {
                    result = { ok: false, name, error: route.error };
                } else if (family === 'canvas') {
                    docCtx.mode = work.mode;
                    docCtx.turnWritten = (name && docCtx.writtenBy[name]) || 0;
                    const doc = computeDocBlock(work.files, block, docCtx);
                    if (doc.ok) {
                        applied = doc.block;
                        result = computeBlock(work.files, applied);
                        if (block.kind === 'file' && name) docCtx.writtenBy[name] = String(applied.payload.content || '').trim().length;
                    } else if (doc.demote) {
                        // Seconde réécriture bien plus courte (fermante mal écrite…) : rendue dans la réponse, le texte précédent gardé
                        endStreaming();
                        const html = demotedBlockText(block);
                        return html ? { html, always: true } : '';
                    } else {
                        result = doc;
                    }
                } else if ((block.kind === 'file' || block.kind === 'edit-loose') && existedBefore && shown
                    && state.promptFull && !state.promptFull.has(name) && !written.has(name)) {
                    // Gros projet : réécrire un fichier dont l'IA n'a que le plan le détruirait ; refusé, la relance le lui envoie
                    result = { ok: false, name, error: block.viaTool
                        ? `tu as réécrit « ${name} » sans l'avoir lu en entier : il n'a pas été modifié. Lis-le d'abord (read_file), ou modifie seulement un passage lu avec edit_file`
                        : `tu as réécrit « ${name} » sans l'avoir lu en entier : il n'a pas été modifié. Lis-le d'abord (<artifact-read name="${name}" />), ou modifie seulement un passage lu avec <artifact-edit>` };
                    touchWorkingSet(name, null, true);
                    state.turnReads.add(name);
                } else {
                    result = computeBlock(work.files, block);
                }
                if (result.ok) {
                    if (name) written.add(name);
                    commitResult(work.files, result);
                    if (result.content !== null) work.selectedFile = result.name;
                    // Le premier bloc réussi fixe l'espace de la conversation
                    if (!work.mode) work.mode = family;
                    if (family === 'canvas' && result.name) {
                        const prev = work.docTitles[result.name] || '';
                        work.docTitles[result.name] = block.kind === 'file' ? resolveDocTitle(block.payload.title, result.content, prev)
                            : prev || resolveDocTitle('', result.content, '');
                    }
                    if (shown) {
                        const modeChanged = state.mode !== work.mode || JSON.stringify(titlesToSave(state.docTitles, work.files, 'canvas')) !== JSON.stringify(titlesToSave(work.docTitles, work.files, 'canvas'));
                        handleBlock(applied);
                        // Espace et titres après le bloc (l'historique garde ceux d'avant)
                        state.mode = work.mode;
                        state.docTitles = cloneTitles(work.docTitles);
                        if (modeChanged) { render(); notifyStateChange(); }
                        // L'IA connaît ce fichier tel qu'elle vient de l'écrire
                        if (name in state.files) state.aiFiles[name] = state.files[name];
                        else if (name) delete state.aiFiles[name];
                        // Gros projet : envoyé en priorité aux messages suivants
                        if (family === 'artifacts' && name) {
                            if (name in state.files) touchWorkingSet(name, null, true);
                            else state.workingSet = state.workingSet.filter(e => e.name !== name);
                        }
                    }
                } else {
                    console.warn('[canvas]', result.error);
                    work.opErrors.push(result.error);
                    if (work.opErrors.length > 10) work.opErrors.shift();
                    if (shown) {
                        state.lastError = result.error;
                        rememberOpError(result.error);
                        render();
                    }
                }
                // Texte du Canvas : rédigé s'il n'existait pas (ou était vide)
                const fresh = family === 'canvas' ? !existedBefore || !String(before || '').trim() : !existedBefore;
                if (result.ok && name) {
                    let kind = null;
                    if (family === 'canvas') kind = fresh ? 'create' : result.content !== before ? 'edit' : null;
                    else if (block.kind === 'file') kind = existedBefore ? 'edit' : 'create';
                    else if (block.kind === 'edit-loose') kind = !existedBefore ? 'create' : result.content !== before ? 'edit' : null;
                    else if (block.kind === 'edit' && result.content !== before) kind = 'edit';
                    else if (block.kind === 'delete') kind = 'delete';
                    if (kind) {
                        const op = { kind, name, before, after: (kind === 'delete' ? null : result.content) };
                        operations.push(op);
                        if (typeof opts.onOperation === 'function') {
                            try { opts.onOperation(op); } catch (e) { console.error(e); }
                        }
                    }
                }
                // Bloc traité : fin de l'état d'écriture, et le prochain fichier peut prendre le focus (sauf choix de l'utilisateur)
                if (state.streamingFile && state.streamingFile.name === name) {
                    state.streamingFile = null;
                    if (!state._streamSelectManual) state._streamSelectPinned = null;
                    render();
                }
                persist();
                // En cas d'échec, un badge d'erreur est toujours ajouté, même si « Modification de… » est déjà affiché
                if (!result.ok) {
                    turnErrors.push(result.error);
                    if (name) failedNames.add(name);
                    // Gros projet : modification ratée d'un fichier que l'IA n'avait pas en entier : la relance le lui envoie
                    if (shown && family === 'artifacts' && name && name in work.files && state.promptFull && !state.promptFull.has(name)) {
                        touchWorkingSet(name, null, true);
                        state.turnReads.add(name);
                    }
                    const label = family === 'canvas' ? (docNamesOf(work.files).length > 1 && name && name in work.files ? `Modification de « ${docTitleIn(work.files, work.docTitles, name) || 'Sans titre'} » non appliquée` : 'Modification du texte du Canvas non appliquée')
                        : name ? `Modification de ${name} non appliquée` : 'Modification des Artifacts non appliquée';
                    return { html: buildInlineErrorMarker(label, family), always: true };
                }
                if (repeatsBadge(badgeKey(block.kind, name))) return '';
                const severalDocs = family === 'canvas' && docNamesOf(work.files).length > 1;
                const marker = family === 'canvas'
                    ? buildInlineOpMarker(name, { kind: 'file', family }, !fresh, severalDocs || startedEmpty ? (docTitleIn(work.files, work.docTitles, name) || (severalDocs ? 'Sans titre' : '')) : '')
                    : buildInlineOpMarker(name, block, existedBefore);
                if (marker && block.kind !== 'delete' && block.kind !== 'read') shownNames.add(name);
                return marker;
            },
            // Bloc ouvert pas encore fermé : écriture en direct dans le viewer et la liste (rendu limité par rAF)
            (() => {
                let rafScheduled = false;
                let switchedToCode = false;
                return (progress) => {
                    // Balise sans nom : code ou texte, jugé dès les premiers caractères pour ne pas ouvrir la vue texte
                    if (!work.mode || work.mode === 'canvas') {
                        const as = codeFileOf({ kind: progress.kind, family: progress.family, tag: progress.tag, rawName: progress.rawName, payload: { name: progress.name, content: progress.partial || '' } }, true);
                        if (as === 'wait') return '';
                        if (as.family !== progress.family) progress = { ...progress, family: as.family, name: as.payload.name };
                    }
                    // Bloc rendu dans la réponse ou en erreur : ni volet, ni écriture en direct, ni badge
                    const route = routeBlock({ kind: progress.kind, family: progress.family, payload: { name: progress.name, content: progress.partial || '' } }, true);
                    if (route !== 'apply') return '';
                    // Fichier verrouillé : refusé à la fin du bloc, rien d'affiché avant
                    if (progress.family !== 'canvas' && work.locked.has(progress.name) && progress.name in work.files) return '';
                    const existedBefore = Object.prototype.hasOwnProperty.call(work.files, progress.name)
                        && (progress.family !== 'canvas' || !!String(work.files[progress.name]).trim());
                    if (syncIfBack()) {
                        // Artifacts sur l'aperçu : il y reste et le volet s'ouvre en fin de tour ; sinon tout de suite, sur le code
                        const keepPreview = state.mode === 'artifacts' && state.activeTab === 'preview';
                        if (!keepPreview) openPanel();
                        else state.aiWriting = progress.name;
                        state.streamingFile = {
                            kind: progress.kind,
                            family: progress.family,
                            name: progress.name,
                            partial: progress.partial || null,
                            title: progress.title || '',
                            // Canvas : suite d'un texte coupé, ou demande sur un passage (texte affiché, passage surligné jusqu'au bloc)
                            append: progress.family === 'canvas' && docCtx.appendDoc && existedBefore,
                            keepDoc: progress.family === 'canvas' && !!docCtx.focus && existedBefore
                        };
                        // Premiers fichiers : le code qui arrive est montré une fois par tour (un retour sur l'aperçu est respecté)
                        if (!keepPreview && !switchedToCode && state.activeTab === 'preview') setTab('code');
                        switchedToCode = true;
                        // Sélection auto une seule fois (pas d'écrasement d'un choix manuel) ; suit l'écriture si elle ne montre plus rien
                        const pinnedVoid = !state._streamSelectManual && !(state.selectedFile in state.files);
                        if (state.selectedFile !== progress.name && (!state._streamSelectPinned || pinnedVoid)) {
                            state.selectedFile = progress.name;
                            state._streamSelectPinned = progress.name;
                        }
                        if (!rafScheduled) {
                            rafScheduled = true;
                            requestAnimationFrame(() => {
                                rafScheduled = false;
                                render();
                            });
                        }
                    }
                    // Badge renvoyé au premier progress du bloc : il apparaît dès le début de la génération
                    if (progress.firstTime) {
                        // Début pareil à un contenu de remplacement (balise recopiée) : badge différé ; un appel d'outil a déjà le sien
                        const start = (progress.partial || '').trim();
                        const maybePlaceholder = start ? (ARTIFACTS_PLACEHOLDER.startsWith(start) || CANVAS_PLACEHOLDER.startsWith(start) || PLACEHOLDER_START_RE.test(start)) : !progress.viaTool;
                        if (progress.kind === 'file' && maybePlaceholder) return '';
                        // Modification par balise, plusieurs documents : document visé (et badge) sûr à la fin du bloc (retargetDocEdit)
                        if (progress.kind === 'edit' && progress.family === 'canvas' && !progress.viaTool && work.mode === 'canvas' && docNamesOf(work.files).length > 1) return '';
                        if (repeatsBadge(badgeKey(progress.kind, progress.name))) return '';
                        // Une modification est toujours une édition ; un fichier, une création s'il n'existe pas encore
                        const synthBlock = { kind: progress.kind, family: progress.family, payload: { name: progress.name } };
                        const docCount = docNamesOf(work.files).length + (progress.name in work.files ? 0 : 1);
                        // Tour commencé sans texte : chaque texte à son titre, même le premier (d'autres peuvent suivre)
                        const several = work.mode === 'canvas' && docCount > 1;
                        const docLabel = progress.family === 'canvas' && (several || startedEmpty)
                            ? (resolveDocTitle(progress.title || '', '', '') || docTitleIn(work.files, work.docTitles, progress.name) || (several ? 'Sans titre' : '')) : '';
                        const marker = buildInlineOpMarker(progress.name, synthBlock, existedBefore, docLabel);
                        if (marker) shownNames.add(progress.name);
                        return marker;
                    }
                    return '';
                };
            })(),
            dialect);
            state._streamSelectPinned = null;
            state._streamSelectManual = false;
            // Fichier choisi par l'utilisateur pendant ce tour : _streamSelectManual retombe à la fin d'un fichier, pas lui
            state._turnPicked = false;
            parser.getOperations = () => operations.slice();
            parser.openedPanel = () => shownByTurn;
            parser.getTurnBaseline = () => cloneFiles(turnBaseline);
            // État à la fin de ce tour, et son espace et son titre (canvasAfter des messages)
            parser.getTurnResult = () => cloneFiles(work.files);
            parser.getTurnResultMeta = () => ({ mode: work.mode, docTitles: titlesToSave(work.docTitles, work.files, work.mode), selectedFile: work.selectedFile, assets: assetsMeta(work.assets) });
            // Espace et titre avant ce tour (canvasBeforeMeta des messages)
            parser.getTurnBaselineMeta = () => ({ mode: turnBaselineMeta.mode, docTitles: turnBaselineMeta.docTitles, selectedFile: turnBaselineMeta.selectedFile, assets: turnBaselineMeta.assets });
            // Erreurs du tour (sans celles qu'un appel d'outil suivant a corrigées)
            parser.getTurnErrors = () => turnErrors.filter((e, i) => !resolvedErrors.has(i));
            // Fichiers demandés en lecture (pas ceux lus par un appel d'outil : elle a eu leur contenu)
            parser.getReads = () => reads.filter(r => !r.answered).map(r => ({ ...r }));
            // Guide demandé par la balise (l'outil davidtwentyai_guide l'a reçu aussitôt)
            parser.getGuide = () => guideAsked;
            // Fichiers dont une modification a échoué sans autre réussite (leur badge « Modification de… » est trompeur)
            parser.getFailedNames = () => [...failedNames].filter(n => !operations.some(op => op.name === n));
            // Badges « Création » ou « Modification » sans rien de changé (appel refusé, contenu identique, autre document visé)
            parser.getStaleBadgeNames = () => [...shownNames].filter(n => !operations.some(op => op.name === n));
            // Bloc resté ouvert en fin de flux ({ kind, family, name, partial }) : non appliqué, sauf un texte du Canvas
            let cut = null;
            parser.getCut = () => cut;

            // ---- Outils : appels d'outils de l'IA (api.js) ----
            // Appliqués comme la balise équivalente ; le compte rendu repart au modèle, qui peut corriger aussitôt
            let injected = '';
            let usedTools = false;
            const toolErrorFile = new Map();   // index dans turnErrors → fichier
            const resolvedErrors = new Set();
            // Badge d'échec : montré en fin de réponse si aucun appel suivant n'a réussi à modifier le fichier
            const failMarkers = new Map();
            parser.usedTools = () => usedTools;
            const toolFileName = v => typeof v === 'string' ? aiFileName(v) : '';
            const editedLines = (text, replace) => {
                const at = replace ? String(text).indexOf(replace) : -1;
                if (at < 0) return '';
                const first = String(text).slice(0, at).split('\n').length;
                const last = first + replace.split('\n').length - 1;
                return first === last ? ` (ligne ${first})` : ` (lignes ${first} à ${last})`;
            };
            const readResult = (r, asked) => {
                if (!r) return 'Erreur : lecture impossible.';
                r.answered = true;
                if (r.unreadable) return `Erreur : ${r.name} n'est pas lisible par toi (image, fichier binaire, minifié ou trop gros) : tu sais seulement qu'il existe.`;
                if (!r.exists || typeof work.files[r.name] !== 'string') return `Erreur : « ${asked} » est introuvable. Vérifie son nom dans la liste des fichiers.`;
                const text = work.files[r.name];
                const total = lineCount(text);
                const part = sliceLines(text, r.range || { from: 1, to: total });
                // Lu en entier : il pourra être réécrit (write_file)
                if (part.range.from === 1 && part.range.to >= total && isShown() && state.promptFull) state.promptFull.add(r.name);
                const more = part.range.to < total ? `\n[… suite : lignes ${part.range.to + 1} à ${total}, à lire avec read_file, from et to]` : '';
                return `--- ${r.name} (lignes ${part.range.from} à ${part.range.to} sur ${total}) ---\n${part.text}${more}\n--- fin de ${r.name} ---`;
            };
            // Espace choisi par le premier appel de création de la réponse (voir toolProgress)
            let progressSpace = '';
            parser.toolCall = function (call) {
                // Appel fait après la note sur un repère recopié : le repère n'est plus une erreur
                if (fakeNoted) fakeResolved = true;
                usedTools = true;
                const args = call && call.args && typeof call.args === 'object' ? call.args : {};
                const tool = call && call.name;
                let name = toolFileName(args.name);
                let block;
                const docTarget = typeof args.document === 'string' ? args.document.replace(/\s+/g, ' ').trim() : '';
                const docList = () => docNamesOf(work.files).map(n => '« ' + (docTitleIn(work.files, work.docTitles, n) || 'Sans titre') + ' »').join(', ');
                const unknownDoc = () => `Erreur : aucun document « ${docTarget} » dans le Canvas. Documents : ${docList()}.`;
                if (tool === 'davidtwentyai_guide') return davidtwentyaiGuide(work.mode);
                if (tool === 'read_console') {
                    if (!isShown()) return 'Console indisponible : l\'utilisateur a changé de conversation.';
                    injected += CONSOLE_READ_MARKER;
                    return consoleForAi(args);
                }
                if (tool === 'read_document') {
                    const n = docByTitle(work.files, work.docTitles, docTarget);
                    if (!n) return docTarget ? unknownDoc() : 'Erreur : read_document demande « document » (son titre).';
                    const text = String(work.files[n] || '');
                    return `--- document « ${docTitleIn(work.files, work.docTitles, n) || 'Sans titre'} » (${lineCount(text)} lignes) ---\n${text}\n--- fin du document ---`;
                }
                if (tool === 'write_document' || tool === 'create_document') {
                    if (typeof args.content !== 'string' || !args.content.trim()) return `Erreur : ${tool} demande « title » et « content » (le texte complet, en Markdown).`;
                    const title = typeof args.title === 'string' ? resolveDocTitle(args.title, '', '') : '';
                    if (tool === 'create_document' && work.mode === 'canvas' && docNamesOf(work.files).length) name = freeDocName(work.files, title);
                    else {
                        name = dialect.docName(title, '', docTarget);
                        if (!name) return unknownDoc();
                    }
                    block = { kind: 'file', family: 'canvas', tag: 'doc', rawName: '', payload: { name, content: cleanBlockBody(name, args.content, 'canvas'), title } };
                } else if (tool === 'edit_document') {
                    // « find » vide : le passage choisi par l'utilisateur (« Demander à l'IA »), comme un <replace> seul
                    name = dialect.docName('', '', docTarget);
                    if (!name) return unknownDoc();
                    if (typeof args.replace !== 'string') return 'Erreur : edit_document demande « find » (passage exact du texte, non vide) et « replace ».';
                    const hasFind = typeof args.find === 'string' && !!args.find;
                    const loc = hasFind ? locateFind(String(work.files[name] || ''), args.find, true) : null;
                    const findHere = !!loc && (!loc.error || loc.error === 'ambiguous');
                    const focusEx = docCtx.focus && typeof docCtx.focus.excerpt === 'string' ? docCtx.focus.excerpt : '';
                    const likeFocus = !hasFind || !focusEx || vocabShare(args.find, focusEx) >= 0.5 || vocabShare(focusEx, args.find) >= 0.5;
                    if (hasFind && (findHere || !docCtx.focus)) block = { kind: 'edit', family: 'canvas', payload: { name, pairs: [{ find: args.find, replace: args.replace }] } };
                    else if (docCtx.focus && likeFocus) block = { kind: 'edit-replace', family: 'canvas', payload: { name, content: trimBlockBody(args.replace) } };
                    else if (docCtx.focus) return 'Erreur : « find » introuvable dans le texte, et sans rapport avec le passage choisi par l\'utilisateur : rien n\'a été modifié. Recopie le passage exact, ou laisse « find » vide pour remplacer le passage choisi.';
                    else return 'Erreur : edit_document demande « find » (passage exact du texte, non vide) et « replace ».';
                } else if (tool === 'rename_document') {
                    if (typeof args.title !== 'string' || !args.title.trim()) return 'Erreur : rename_document demande « title » (le nouveau titre).';
                    name = dialect.docName('', '', docTarget);
                    if (!name) return unknownDoc();
                    block = { kind: 'rename', family: 'canvas', payload: { name, title: args.title, from: docTarget } };
                } else if (tool === 'write_file') {
                    if (!name || typeof args.content !== 'string') return 'Erreur : write_file demande « name » (chemin du fichier) et « content » (son contenu complet).';
                    // Comme la balise : un .md ou .txt dans une conversation sans Artifacts devient le texte du Canvas
                    const family = dialect.familyOf('file', name);
                    block = { kind: 'file', family, tag: 'file', rawName: name, payload: { name: family === 'canvas' ? dialect.docName('', name) : name, content: args.content, title: '' } };
                } else if (tool === 'edit_file') {
                    if (!name || typeof args.find !== 'string' || !args.find || typeof args.replace !== 'string') return 'Erreur : edit_file demande « name », « find » (texte exact du fichier, non vide) et « replace ».';
                    block = { kind: 'edit', family: 'artifacts', payload: { name, pairs: [{ find: args.find, replace: args.replace }] } };
                } else if (tool === 'delete_file') {
                    if (!name) return 'Erreur : delete_file demande « name ».';
                    block = { kind: 'delete', family: 'artifacts', payload: { name } };
                } else if (tool === 'read_file') {
                    if (!name) return 'Erreur : read_file demande « name ».';
                    const from = Number(args.from), to = Number(args.to);
                    const range = from > 0 || to > 0 ? validRange({ from: from > 0 ? from : 1, to: to > 0 ? to : from + 199 }) : null;
                    block = { kind: 'read', family: 'artifacts', payload: { name, range } };
                } else {
                    return `Erreur : outil inconnu « ${tool} ». Outils disponibles : ${artifactToolSpecs().map(t => t.name).join(', ')}.`;
                }
                block.viaTool = true;
                const nOps = operations.length, nErr = turnErrors.length, nOpErr = work.opErrors.length, nReads = reads.length;
                const html = parser.inject(block);
                if (block.kind === 'read') {
                    injected += html;
                    return readResult(reads[nReads], name);
                }
                // Échecs déjà dans le compte rendu : pas répétés au message suivant (les restants, voir flush)
                const added = work.opErrors.splice(nOpErr);
                if (added.length && isShown()) state.opErrors = state.opErrors.filter(e => !added.includes(e));
                if (operations.length > nOps) {
                    const done = operations[operations.length - 1].name || name;
                    for (const [i, f] of toolErrorFile) if (f === done || f === name) resolvedErrors.add(i);
                    failMarkers.delete(done);
                    failMarkers.delete(name);
                    injected += html;
                    if (block.kind === 'delete') return `ok : ${done} supprimé.`;
                    if (block.kind === 'rename') return `ok : titre changé en « ${docTitleIn(work.files, work.docTitles, done) || block.payload.title} ».`;
                    const several = block.family === 'canvas' && docNamesOf(work.files).length > 1;
                    const docNamed = () => `« ${docTitleIn(work.files, work.docTitles, done) || 'Sans titre'} »`;
                    if (block.kind === 'file' && block.family === 'canvas') return several ? `ok : document ${docNamed()} enregistré (${lineCount(work.files[done] || '')} lignes).` : `ok : texte enregistré dans le Canvas (${lineCount(work.files[done] || '')} lignes).`;
                    if (block.kind === 'file') return `ok : ${done} enregistré (${lineCount(work.files[done] || '')} lignes).`;
                    if (block.family === 'canvas') return `ok : passage remplacé dans ${several ? 'le document ' + docNamed() : 'le texte du Canvas'}${editedLines(work.files[done] || '', block.kind === 'edit-replace' ? block.payload.content : args.replace)}.`;
                    return `ok : passage remplacé dans ${done}${editedLines(work.files[done] || '', args.replace)}.`;
                }
                // Rendu dans la réponse (exemple, texte trop court) : le dire, sans quoi le modèle réessaierait
                if (block.kind === 'file' && demoted.has(block.payload.name)) {
                    injected += html;
                    return 'Non enregistré : ce contenu est affiché dans ta réponse (exemple pour une question, ou texte court). N\'appelle plus d\'outil pour cette réponse ; termine par une courte explication.';
                }
                if (turnErrors.length > nErr || added.length) {
                    if (html) failMarkers.set(name, html);
                    if (turnErrors.length > nErr) {
                        for (let i = nErr; i < turnErrors.length; i++) toolErrorFile.set(i, name);
                        return 'Erreur : ' + toolWords(turnErrors[turnErrors.length - 1]);
                    }
                    return 'Refusé : ' + toolWords(added[added.length - 1]);
                }
                injected += html;
                return 'Rien n\'a changé : contenu identique, ou demande ignorée.';
            };
            /* Le premier fichier ou texte choisit l'espace ; un appel de l'autre espace (demote) n'a pas de badge */
            parser.toolProgress = function (call) {
                const args = call && call.args && typeof call.args === 'object' ? call.args : {};
                const creates = call && (call.name === 'write_file' || call.name === 'write_document' || call.name === 'create_document');
                if (creates && !work.mode) {
                    const fileName = call.name === 'write_file' && args.__open !== 'name' ? toolFileName(args.name) : '';
                    const space = call.name === 'write_file' ? (fileName ? dialect.familyOf('file', fileName) : '') : 'canvas';
                    if (space && !progressSpace) progressSpace = space;
                    if (space && progressSpace !== space) return;
                }
                // Document visé par son titre : seulement une fois écrit en entier
                const target = typeof args.document === 'string' && args.__open !== 'document' ? args.document : '';
                if (typeof args.document === 'string' && args.__open === 'document') return;
                if ((call.name === 'write_document' || call.name === 'create_document') && (typeof args.content === 'string' || args.content === undefined)) {
                    const title = typeof args.title === 'string' && args.__open !== 'title' ? resolveDocTitle(args.title, '', '') : '';
                    // Titre pas encore là : c'est lui qui choisit le document (sinon un badge et un onglet de trop)
                    if (!title && !target && (args.__open === 'title' || args.content === undefined || (startedEmpty && docNamesOf(work.files).length))) return;
                    let docName;
                    if (call.name === 'create_document' && work.mode === 'canvas' && docNamesOf(work.files).length) {
                        if (!title) return;
                        docName = freeDocName(work.files, title);
                    } else docName = dialect.docName(title, '', target);
                    if (!docName) return;
                    injected += parser.injectProgress({ kind: 'file', family: 'canvas', tag: 'doc', rawName: '', name: docName, title, partial: typeof args.content === 'string' ? args.content : '' });
                    return;
                }
                if (call.name === 'edit_document') {
                    // Plusieurs documents : « document » peut arriver après « find » et « replace »
                    if (!target && work.mode === 'canvas' && docNamesOf(work.files).length > 1) return;
                    const docName = dialect.docName('', '', target);
                    if (docName) injected += parser.injectProgress({ kind: 'edit', family: 'canvas', name: docName, partial: null });
                    return;
                }
                const name = args.__open === 'name' ? '' : toolFileName(args.name);
                if (!name) return;
                // Nom connu, contenu pas encore là (OpenRouter, Mistral) : le fichier se montre déjà en écriture
                if (call.name === 'write_file' && (typeof args.content === 'string' || args.content === undefined)) {
                    const family = dialect.familyOf('file', name);
                    injected += parser.injectProgress({ kind: 'file', family, tag: 'file', rawName: name, name: family === 'canvas' ? dialect.docName('', name) : name, title: '', partial: typeof args.content === 'string' ? args.content : '' });
                } else if (call.name === 'edit_file') {
                    injected += parser.injectProgress({ kind: 'edit', family: 'artifacts', name, partial: null });
                }
            };
            // Repère recopié au lieu d'un appel (api.js, tour sans outil) : note pour que l'IA fasse le vrai appel
            let fakeNoted = false, fakeResolved = false;
            parser.fakeMentionNote = function (text) {
                const found = [...new Set(String(text || '').match(new RegExp(FAKE_MENTION_SRC, 'gi')) || [])];
                if (!found.length) return '';
                fakeNoted = true;
                return `Note de DavidTwentyAI, que l'utilisateur ne voit pas : tu as écrit ${found.slice(0, 3).map(f => '« ' + f + ' »').join(', ')} au lieu d'appeler un outil. Ces repères sont ajoutés par DavidTwentyAI après un vrai appel d'outil ; écrits par toi, ils ne font rien : rien n'a été lu ni modifié. Fais-le maintenant avec tes outils, sans répondre à cette note ni répéter ce que tu as déjà écrit.`;
            };
            // Appel illisible (api.js) : badge d'échec à sa place, et la réécriture qui suit aura son propre badge
            parser.toolUnreadable = function (call) {
                const args = call && call.args && typeof call.args === 'object' ? call.args : {};
                const name = args.__open === 'name' ? '' : toolFileName(args.name);
                if (!name || (call.name !== 'write_file' && call.name !== 'edit_file')) return;
                failedNames.add(name);
                if (isShown() && state.streamingFile && state.streamingFile.name === name) {
                    state.streamingFile = null;
                    state._streamSelectPinned = null;
                    state._streamSelectManual = false;
                    render();
                }
                injected += parser.marker(buildInlineErrorMarker(call.name === 'edit_file' ? `Modification de ${name} non appliquée : appel illisible` : `${name} non enregistré : appel illisible`, 'artifacts'));
            };
            // Texte visible du tour, pour repérer une mention recopiée
            let visibleText = '';
            const _origFeed = parser.feed;
            parser.feed = function(chunk) {
                const r = _origFeed(chunk);
                // Badges des appels d'outils faits depuis le dernier morceau de texte
                if (injected) { r.visible = injected + r.visible; injected = ''; }
                visibleText += r.visible;
                return r;
            };
            const _origFlush = parser.flush;
            parser.flush = function(usage) {
                const result = _origFlush(usage);
                if (injected) { result.visible = injected + result.visible; injected = ''; }
                if (failMarkers.size) { result.visible += [...failMarkers.values()].join(''); failMarkers.clear(); }
                visibleText += result.visible;
                cut = result.cut;
                // Échecs restés sans correction : rappelés au modèle au message suivant
                if (usedTools) {
                    const left = turnErrors.filter((e, i) => toolErrorFile.has(i) && !resolvedErrors.has(i)).map(toolWords);
                    for (const e of left) {
                        work.opErrors.push(e);
                        if (isShown()) rememberOpError(e);
                    }
                    if (left.length) persist();
                }
                // Texte du Canvas coupé mais pas appliqué : rendu dans la réponse, ou refusé
                if (cut && cut.partial && !operations.some(op => op.name === cut.name)) {
                    cut = demoted.has(cut.name) ? null : { kind: 'file', family: 'canvas', name: cut.name };
                }
                if (cut) console.warn('[canvas] réponse arrêtée avant la fin du bloc', cut.name || '(sans nom)');
                // Modification annoncée sans balise, ou balise recopiée de l'historique : signalé à l'utilisateur et à l'IA
                let error = null;
                if (operations.length === 0 && placeholderCopies > 0) {
                    error = placeholderFamily === 'canvas'
                        ? 'tu as recopié une balise contenant « ' + CANVAS_PLACEHOLDER + ' » au lieu d\'écrire le texte : rien n\'a été modifié'
                        : 'tu as recopié une balise contenant « ' + ARTIFACTS_PLACEHOLDER + ' » au lieu d\'écrire le contenu du fichier : rien n\'a été modifié';
                } else if (operations.length === 0 && !fakeResolved && FAKE_OP_RE.test(visibleText.replace(/<div class="canvas-inline-op[\s\S]*?<\/div>/g, ''))) {
                    const how = opts.tools ? 'sans appeler d\'outil' : 'sans écrire de balise';
                    error = work.mode === 'canvas'
                        ? `tu as annoncé une modification du texte du Canvas ${how} : le texte n'a pas changé`
                        : `tu as annoncé une modification ${how} : aucun fichier n'a été créé ni modifié`;
                }
                if (error) {
                    turnErrors.push(error);
                    work.opErrors.push(error);
                    if (isShown()) {
                        state.lastError = error;
                        rememberOpError(error);
                    }
                    persist();
                }
                // L'IA a supprimé tous les fichiers : la conversation pourra utiliser l'un ou l'autre espace
                if (work.mode && !Object.keys(work.files).length) {
                    work.mode = null;
                    work.docTitles = Object.create(null);
                    if (!error) persist();
                }
                if (syncIfBack()) {
                    if (!Object.keys(state.files).length && !hasAssets()) {
                        state.mode = null;
                        state.docTitles = Object.create(null);
                    }
                    const chosen = !!(state._streamSelectManual || state._turnPicked);
                    state._turnPicked = false;
                    state.streamingFile = null;
                    state._streamSelectPinned = null;
                    state._streamSelectManual = false;
                    state.aiWriting = null;
                    if (operations.length > 0 && state.mode === 'canvas') {
                        const doc = activeDoc();
                        const before = doc && turnBaseline[doc] != null ? turnBaseline[doc] : '';
                        if (doc && before.trim()) state._docFlash = { before, after: state.files[doc] };
                    } else if (operations.length > 0) {
                        previewAfterAiTurn(operations.filter(op => op.kind !== 'delete').map(op => op.name), chosen);
                        if (!isPanelOpen()) showPanel();
                    }
                    render();
                    notifyStateChange();
                }
                return result;
            };
            return parser;
        },
        markersToText,
        markersToPlainText,
        stripFakeMentions,
        hideFakeMentions,
        unfenceMarkers,
        importCodeBlocks,
        badgeKeys,
        trailingBadgeKey,
        buildCutMarker,
        dropCutMarker,
        dropOpBadges,
        recordTurnResult,
        /** Part des mots longs de `ref` retrouvés dans `text` (0 à 1). */
        textKinship: vocabShare,
        /** Message de l'utilisateur : 'create', 'question' ou ''. */
        askKind,
        /** Vide les erreurs en attente (déjà transmises dans un message). */
        clearPendingErrors() { state.opErrors = []; state.lastError = null; render(); },
        buildSystemPromptSuffix,
        buildPromptParts,
        estimatePromptTokens,
        decorateApiMessage,
        /** Nombre de fichiers des Artifacts, ou de documents du Canvas. */
        fileCount() { return allFileNames().length; },
        /** Espace de la conversation affichée : null, 'artifacts' ou 'canvas'. */
        getMode() { return currentMode(); },
        /** Titre affiché du texte du Canvas ('' : sans titre). */
        getDocTitle() {
            const doc = activeDoc();
            return doc ? docTitleIn(state.files, state.docTitles, doc) : '';
        },
        /** Titres des documents du Canvas ({ nom: titre } ; undefined hors Canvas). */
        getDocTitles() {
            return titlesToSave(state.docTitles, state.files, state.mode);
        },
        /** Texte du Canvas ('' hors Canvas). */
        getDocText() {
            const doc = activeDoc();
            return doc ? state.files[doc] : '';
        },
        /* Montre le passage d'une citation cliquée dans le texte du Canvas (volet ouvert) ; true s'il y est */
        revealFocus(focus) {
            if (state.mode !== 'canvas' || !state._doc) return false;
            if (state.showDiff) { state.showDiff = false; render(); }
            return state._doc.revealFocus(focus);
        },

        showPanel,
        hidePanel,
        setTab,
        assetHashMatches,

        /* Passe en onglet Code ; true si le fichier existe ou est en écriture */
        selectFile(name) {
            if (!name) return false;
            // Canvas : son texte, même si le nom a changé depuis le badge
            if (state.mode === 'canvas' && !(name in state.files) && activeDoc()) name = activeDoc();
            const exists = Object.prototype.hasOwnProperty.call(state.files, name) || isAsset(name);
            const isStreaming = state.streamingFile && state.streamingFile.name === name;
            if (!exists && !isStreaming) return false;
            state.selectedFile = name;
            // Choix explicite : le suivi automatique du fichier en écriture ne le remplace pas
            state._streamSelectPinned = name;
            state._streamSelectManual = !!(state.streamingFile || state.busy);
            if (state._streamSelectManual) state._turnPicked = true;
            setTab('code');
            render();
            return true;
        },

        // Snapshots pour rewind lors d'une régénération / édition de message
        getCurrentSnapshot,
        setBaseline,
        artifactToolSpecs,
        davidtwentyaiGuide: (mode) => davidtwentyaiGuide(mode === undefined ? currentMode() : mode),
        consoleNote,
        // Versions (une par réponse de l'IA), données par app.js
        setVersions,
        // Aperçu d'une page (élément cité dans la conversation)
        showPreviewOf,
        restoreSnapshot,
        filesEqual,

        // Rendu des opérations d'un tour dans les bulles de messages
        renderDiffHtml: renderDiff,

        // Introspection pour debug / tests
        _state: state
    };
})();
