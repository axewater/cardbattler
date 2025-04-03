import { MAX_MANA, STARTING_HEALTH, STARTING_HAND_SIZE, MAX_BOARD_SIZE, MAX_HAND_SIZE, AI_TURN_START_DELAY } from './constants.js';
import { cardLibrary } from './cards.js';
import { resetState, getState, getPlayer, getCurrentPlayer, getOpponentPlayer, getOpponentId, setCurrentPlayerId, incrementTurn, getTurn, setGameOver, setMessageState, isGameOver, setDebugMode } from './state.js';
import { renderGame, updatePlayableCards } from './render.js';
import { setMessage, logMessage } from './messaging.js';
import { showGameOverScreen, hideGameOverScreen, showGameUI, hideGameUI } from './uiState.js';
import { cacheDOMElements, getDOMElement, assignElementsToPlayerState } from './dom.js';
import { dealDamage } from './cardEffects.js'; // Needed for fatigue
import { runAITurn } from './aiCore.js';
import { showMulliganUI, hideMulliganUI } from './mulligan.js'; // Import mulligan UI functions
import { defaultDecks } from './decks.js'; // Import default deck data

// --- Game Setup ---

export function initGame() {
    // This function is now primarily for resetting after a game ends.
    // The initial setup (deck building, etc.) happens in startGameWithHero.
    console.log("Initializing game...");
    cacheDOMElements(); // Find and store DOM elements
    hideGameOverScreen();
    hideGameUI(); // Ensure game UI is hidden before starting
    // The actual game start logic is now in startGameWithHero
}

export function startGameWithHero(selectedHero, playerDeckCardIds, isDebug = false) {
    console.log("[GameLogic] startGameWithHero called for:", selectedHero?.name);
    console.log(`Starting game with hero: ${selectedHero.name}, Deck size: ${playerDeckCardIds.length}`);
    console.log(`[GameLogic] Debug mode: ${isDebug}`);

    cacheDOMElements(); // Ensure elements are cached
    hideGameOverScreen(); // Ensure overlay is hidden

    // --- Create Player Draw Pile Instances ---
    const playerDrawPileInstances = playerDeckCardIds.map(cardId => createCardInstanceById(cardId, 'player')).filter(Boolean);

    // --- Create Opponent Draw Pile (Using Default Deck for now) ---
    // TODO: Allow selecting opponent deck or use a smarter default based on player hero?
    const opponentHeroId = selectedHero.id; // For simplicity, opponent uses same class default deck
    const opponentDefaultDeckIds = defaultDecks[opponentHeroId] || defaultDecks.warrior; // Fallback to warrior
    const opponentDrawPileInstances = opponentDefaultDeckIds.map(cardId => createCardInstanceById(cardId, 'opponent')).filter(Boolean);

    // Shuffle the draw pile lists before passing to resetState
    const initialPlayerDrawPile = shuffleDeck(playerDrawPileInstances);
    const initialOpponentDrawPile = shuffleDeck(opponentDrawPileInstances);
    console.log(`[GameLogic] Initial Player Draw Pile Size: ${initialPlayerDrawPile.length}, Opponent: ${initialOpponentDrawPile.length}`);

    // --- Initialize State First ---
    resetState(initialPlayerDrawPile, initialOpponentDrawPile); // Initialize/reset the state object, pass draw piles
    getState().isDebugMode = isDebug; // Set the debug mode in the state

    // --- Now Access Player Data ---
    const player = getPlayer('player');
    const opponent = getPlayer('opponent');

    // Assign DOM elements after state is initialized and players exist
    assignElementsToPlayerState(getPlayer);

    // Draw piles are already shuffled and passed to resetState
    console.log("Player Draw Pile Size:", player.drawPile.length);

    // Draw initial hands
    for (let i = 0; i < STARTING_HAND_SIZE; i++) {
        drawCard(player);
        drawCard(opponent);
    }

    // Start the first turn (Player 1)
    player.maxMana = 1;
    player.currentMana = 1;
    opponent.maxMana = 0; // Opponent starts with 0 mana crystals available on Player 1's turn 1
    opponent.currentMana = 0;

    showGameUI(); // Make the game UI visible now
    renderGame(); // Initial render (will show board/empty hands before mulligan UI pops up)

    // --- Trigger Mulligan Phase ---
    showMulliganUI(); // Show the mulligan screen for the player
    // The first turn will start after the mulligan is confirmed.
}

/**
 * Creates a card instance from card data, assigning a unique instance ID and owner.
 * @param {object} cardData - The card data object from the card library.
 * @param {string} ownerId - 'player' or 'opponent'.
 * @returns {object|null} The created card instance or null if cardData is invalid.
 */
export function createCardInstance(cardData, ownerId) {
    // Create a unique instance of a card from the library
    // Ensure we're using the base data from the library if cardData might be an instance already
    const libraryCard = cardLibrary.find(c => c.id === cardData.id);
    if (!libraryCard) {
        console.error(`Card data not found in library for id: ${cardData?.id}`);
        return null;
    }
    // If the input *was* already an instance, we still want to create a *new* instance
    // based on the library definition for the draw pile.
    if (cardData.instanceId) {
        console.warn(`createCardInstance called with an existing instance (${cardData.name}, ${cardData.instanceId}). Creating new instance from library data.`);
    }
    return {
        ...libraryCard, // Copy properties from library
        instanceId: generateId(), // Assign unique ID for this specific card instance
        owner: ownerId,
        currentHealth: libraryCard.health, // Initialize current health
        currentAttack: libraryCard.attack, // Initialize current attack
        // --- Runtime State (initialized here or when played/entering zone) ---
        canAttack: false,       // Can it attack this turn? (Set true on turn start if eligible)
        hasAttacked: false,     // Has it attacked this turn? (Reset on turn start)
        isFrozen: false,        // Frozen state (Reset on turn start)
        justPlayed: false,      // Played this turn? (Summoning Sickness - set true when played, false on turn start)
        effects: [],            // For temporary effects, statuses etc.
        // --- Derived State (set based on mechanics for easier access) ---
        isTaunt: !!libraryCard.mechanics?.includes("Taunt"),
        isSwift: !!libraryCard.mechanics?.includes("Swift"),
        isStealthed: !!libraryCard.mechanics?.includes("Stealth"), // Initialize Stealth state
        // Add more state as needed (isStealthed, poisonCounters, etc.)
        // Frenzy specific state
        effects: [], // Initialize effects array here
        frenzyTriggered: false,
        frenzyActionId: libraryCard.frenzyActionId || null,
        appliedAuraAttackBonus: 0, // Initialize aura bonus tracking
        frenzyActionParams: libraryCard.frenzyActionParams || {},
    };
}

/**
 * Helper function to create a card instance directly from a card ID.
 * @param {string} cardId - The ID of the card in the card library.
 * @param {string} ownerId - 'player' or 'opponent'.
 * @returns {object|null} The created card instance or null if ID is invalid.
 */
function createCardInstanceById(cardId, ownerId) {
    const cardData = cardLibrary.find(c => c.id === cardId);
    return cardData ? createCardInstance(cardData, ownerId) : null;
}

export function generateId() {
    return Math.random().toString(36).substring(2, 11); // Longer ID for less collision chance
}

export function shuffleDeck(deck) {
    // Fisher-Yates (Knuth) Shuffle
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]]; // Swap elements
    }
    return deck;
}

// --- Turn Management ---

export function startTurn(playerId) {
    if (isGameOver()) return;

    incrementTurn();
    setCurrentPlayerId(playerId);
    const player = getCurrentPlayer();
    const opponent = getOpponentPlayer();
    console.log(`--- Turn ${getTurn()}: ${playerId} ---`);
    logMessage(`--- Turn ${getTurn()} (${playerId}) ---`, 'log-turn');

    // Increase Max Mana (up to MAX_MANA)
    if (player.maxMana < MAX_MANA) {
        player.maxMana++;
    }
    // Refill Mana
    player.currentMana = player.maxMana;

    // --- Start of Turn Effects & Resets ---
    // 1. Reset attack state for player's creatures
    // 2. Remove summoning sickness ('justPlayed')
    // 3. Unfreeze OPPONENT's creatures
    // 4. TODO: Handle other start-of-turn effects (e.g., card triggers)

    // 1. Unfreeze the OPPONENT'S creatures (they thaw at the start of this player's turn)
    opponent.board.forEach(creature => {
        if (creature.isFrozen) {
            creature.isFrozen = false; // Remove frozen status
            logMessage(`${creature.name} unfreezes.`);
            // Its canAttack status will be determined when its owner's turn starts.
        }
    });

    // 2. Reset CURRENT player's creatures' state for the new turn
    player.board.forEach(creature => {
        // Store the 'justPlayed' status from the *previous* turn before resetting it
        const wasJustPlayedLastTurn = creature.justPlayed;
        console.log(`[Start Turn ${getTurn()}] ${player.id}'s ${creature.name} (${creature.instanceId}) - Before update: justPlayed=${wasJustPlayedLastTurn}, isFrozen=${creature.isFrozen}, canAttack=${creature.canAttack}, hasAttacked=${creature.hasAttacked}`);

        // Reset turn-based states
        creature.hasAttacked = false;
        creature.justPlayed = false; // Summoning sickness wears off now

        // Determine if it can attack THIS turn
        // A creature can attack if it's not frozen and has > 0 attack.
        // The 'justPlayed' status only prevents attack on the turn it is played (handled in playCard),
        // unless it has Swift. By the start of the *next* turn, the sickness is gone.
        creature.canAttack = !creature.isFrozen && creature.currentAttack > 0;
        console.log(`[Start Turn ${getTurn()}] ${player.id}'s ${creature.name} (${creature.instanceId}) - After update: justPlayed=${creature.justPlayed}, isFrozen=${creature.isFrozen}, canAttack=${creature.canAttack}, hasAttacked=${creature.hasAttacked} (wasJustPlayedLastTurn=${wasJustPlayedLastTurn})`);
    });

    // TODO: Handle opponent's start-of-turn effects if any apply during player's turn (unlikely)

    // Draw a card
    drawCard(player);

    // Update UI
    // setMessageState(`${playerId}'s turn.`); // State message is less useful now
    setMessage(`${playerId}'s turn.`); // Update prompt bar
    renderGame(); // Render after state updates but before AI turn

    // Enable/disable button
    const endTurnButton = getDOMElement('endTurnButton');
    if (endTurnButton) endTurnButton.disabled = playerId !== 'player';

    // If it's the AI's turn, run its logic
    if (playerId === 'opponent') {
        setMessage("Opponent is thinking..."); // Show message while AI thinks
        // Disable player actions during AI turn (already handled by button disable and event checks)
        setTimeout(runAITurn, AI_TURN_START_DELAY); // Use constant for delay
    }
}

export function endTurn() {
    if (isGameOver()) return;

    const currentPlayerId = getState().currentPlayerId;
    const currentPlayer = getCurrentPlayer();
    logMessage(`${currentPlayerId} ends turn.`);
    console.log(`${currentPlayerId} ends turn.`);

    // --- End of Turn Effects for the player whose turn just ended ---
    // TODO: Implement end-of-turn triggers (e.g., Poison, card effects)
    // Process temporary buffs
    currentPlayer.board.forEach(creature => {
        // Iterate backwards to allow safe removal
        for (let i = creature.effects.length - 1; i >= 0; i--) {
            const effect = creature.effects[i];
            if (effect.type === 'tempBuff') {
                effect.duration--; // Decrement duration
                if (effect.duration <= 0) {
                    // Remove buff stats
                    creature.currentAttack = Math.max(0, creature.currentAttack - effect.attack);
                    creature.currentHealth -= effect.health; // Health can go to 0 or below, death check happens later
                    logMessage(`${creature.name}'s temporary buff (+${effect.attack}/+${effect.health}) wears off.`);
                    creature.effects.splice(i, 1); // Remove the effect object
                }
            }
            // Add handling for other end-of-turn effect types here (e.g., poison)
        }
    });

    // Check win condition *before* starting next turn (e.g., if end-of-turn effect was lethal)
    if (checkWinCondition()) return;

    // Start the next player's turn
    const nextPlayerId = getOpponentId(currentPlayerId);
    startTurn(nextPlayerId);
}

// --- Card Drawing ---

export function drawCard(player) {
    // Check if draw pile is empty
    if (player.drawPile.length === 0) {
        // Check if discard pile has cards
        if (player.discardPile.length > 0) {
            logMessage(`${player.id}'s draw pile is empty. Shuffling discard pile...`, 'log-info');
            // Shuffle discard pile and move it to draw pile
            player.drawPile = shuffleDeck(player.discardPile);
            player.discardPile = []; // Clear discard pile
            console.log(`${player.id} shuffled discard into draw pile. New draw pile size: ${player.drawPile.length}`);
        } else {
            // Both piles are empty - game might end or fatigue could be re-implemented here if desired
            logMessage(`${player.id} has no cards left in draw or discard piles!`, 'log-error');
            console.log(`${player.id} deck and discard empty! Cannot draw.`);
            // Currently, nothing happens. Fatigue is removed.
            return; // Exit the function, cannot draw
        }
    }

    // Proceed with drawing if cards are available in drawPile
    if (player.hand.length >= MAX_HAND_SIZE) {
        const burnedCard = player.drawPile.pop(); // Remove card from draw pile
        const cardName = burnedCard?.name || 'a card';
        console.log(`${player.id} hand full! Card burned: ${cardName}`);
        logMessage(`${player.id}'s hand is full! Burned ${cardName}.`, 'log-error');
    } else {
        const card = player.drawPile.pop(); // Draw from the draw pile
        player.hand.push(card);
        logMessage(`${player.id} draws ${card.name}.`);
        console.log(`${player.id} drew ${card.name}`);
    }
    // No need to re-render here, startTurn/endTurn calls renderGame
    // But update player info immediately if not part of start/end turn?
    // renderPlayerInfo(player); // Maybe needed if called outside turn sequence
    renderGame(); // Render immediately after draw during mulligan
}


// --- Win Condition & Game Over ---

export function checkWinCondition() {
    if (isGameOver()) return true; // Already over

    const player = getPlayer('player');
    const opponent = getPlayer('opponent');

    if (player.heroHealth <= 0 && opponent.heroHealth <= 0) {
        gameOver("Draw!"); // Or decide winner based on who reached 0 first if tracked
        return true;
    }
    if (player.heroHealth <= 0) {
        gameOver("Opponent Wins!");
        return true;
    }
    if (opponent.heroHealth <= 0) {
        gameOver("Player Wins!");
        return true;
    }
    return false; // Game continues
}

export function gameOver(message) {
    console.log("Game Over:", message);
    setGameOver(true, message);
    setMessage(message); // Update message bar immediately with final result
    logMessage(`--- Game Over: ${message} ---`, 'log-turn'); // Log final result
    showGameOverScreen(message); // Show the overlay
}

// --- Mulligan Logic ---

export function confirmMulligan(selectedIndices) {
    console.log("Confirming mulligan with indices:", selectedIndices);
    const player = getPlayer('player');

    // Sort indices descending to avoid issues when removing elements
    selectedIndices.sort((a, b) => b - a);

    const cardsToReplace = [];
    selectedIndices.forEach(index => {
        if (index >= 0 && index < player.hand.length) {
            cardsToReplace.push(player.hand.splice(index, 1)[0]);
        }
    });

    console.log("Cards removed from hand:", cardsToReplace.map(c => c.name));

    // Add replaced cards back to the draw pile
    player.drawPile.push(...cardsToReplace);
    console.log("Cards added back to draw pile. New size:", player.drawPile.length);

    // Shuffle the draw pile
    shuffleDeck(player.drawPile);
    console.log("Draw pile shuffled.");

    // Draw the same number of new cards
    for (let i = 0; i < cardsToReplace.length; i++) {
        drawCard(player);
    }
    console.log("Drew replacement cards. New hand size:", player.hand.length);

    // Return the new hand state for UI updates
    return player.hand;
}
