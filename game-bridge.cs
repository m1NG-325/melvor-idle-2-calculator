using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.CloudMenus;
using GamesByMalcs.Melvor2.Components.Actions;
using GamesByMalcs.Melvor2.Components.ArtisanAction;
using GamesByMalcs.Melvor2.Components.CraftingAction;
using GamesByMalcs.Melvor2.Components.Experience;
using GamesByMalcs.Melvor2.Components.Inventories;
using GamesByMalcs.Melvor2.Conditions;
using GamesByMalcs.Melvor2.Entities.Bank;
using GamesByMalcs.Melvor2.Entities.Fishing;
using GamesByMalcs.Melvor2.Entities.Cooking;
using GamesByMalcs.Melvor2.Entities.Firemaking;
using GamesByMalcs.Melvor2.Entities.Mining;
using GamesByMalcs.Melvor2.Entities.Woodcutting;
using GamesByMalcs.Melvor2.MainMenu;
using GamesByMalcs.Melvor2.Saves;
using Godot;

namespace GodotPlugins.Game;

internal static class Main
{
    [UnmanagedCallersOnly]
    private static byte InitializeFromGameProject(nint engine, nint outgoing, nint incoming, int length)
    {
        try
        {
            Register(engine, outgoing, incoming, length);
            return 1;
        }
        catch (Exception)
        {
            return 0;
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Register(nint engine, nint outgoing, nint incoming, int length)
    {
        var imports = new Godot.NativeInterop.GodotDllImportResolver(engine);
        NativeLibrary.SetDllImportResolver(typeof(GodotObject).Assembly, imports.OnResolveDllImport);
        Godot.NativeInterop.NativeFuncs.Initialize(incoming, length);
        Godot.Bridge.ManagedCallbacks.Create(outgoing);
        Godot.Bridge.ScriptManagerBridge.LookupScriptsInAssembly(typeof(GamesByMalcs.Melvor2.Game).Assembly);
        Godot.Bridge.ScriptManagerBridge.LookupScriptsInAssembly(typeof(Main).Assembly);
        Callable.From(Connect).CallDeferred();
    }

    private static void Connect()
    {
        var directory = System.Environment.GetEnvironmentVariable("MELVOR_CALCULATOR_BRIDGE_DIR");
        if (string.IsNullOrEmpty(directory) || Engine.GetMainLoop() is not SceneTree tree) return;
        var bridge = new CalculatorBridge(tree, directory);
        tree.ProcessFrame += bridge.Poll;
    }
}

internal sealed class CalculatorBridge(SceneTree tree, string directory)
{
    private readonly string requestFile = Path.Combine(directory, "request.json");
    private readonly string responseFile = Path.Combine(directory, "response.json");
    private static readonly PropertyInfo? GameProperty = typeof(GameDriver).GetProperty(
        "Game", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
    private static readonly PropertyInfo? ActiveSaveId = typeof(SaveManager).GetProperty(
        "ActiveSaveId", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
    private static readonly MethodInfo? ContinueToGame = typeof(MelvorCloudMenuView).GetMethod(
        "ContinueToGameButtonPressedHandler", BindingFlags.Instance | BindingFlags.NonPublic);
    private static readonly Func<ActionComponent, bool>? IsPerformingAction = typeof(ActionComponent)
        .GetProperty("IsPerformingAction", BindingFlags.Instance | BindingFlags.NonPublic)?
        .GetGetMethod(true)?.CreateDelegate<Func<ActionComponent, bool>>();
    private long nextPoll;
    private GameDriver? driver;
    private GamesByMalcs.Melvor2.Game? owner;
    private ActionComponent? active;
    private Func<bool>? ownsAction;
    private string? lease;
    private long lastFrame;
    private long elapsed;
    private int duration;
    private string? outcome;
    private Guid? activeCharacter;
    private string? autoLoadLease;
    private string? continueLease;
    private string? verifiedSaveHash;
    private Guid verifiedSaveId;
    private GamesByMalcs.Melvor2.Game? verifiedSaveGame;
    private string? goalItem;
    private int goalQuantity;
    private double gained;
    private Func<double>? goalStock;
    private bool reachWhenBelow;
    private bool countSpent;
    private Action? releaseGoal;
    private double GoalProgress => goalStock?.Invoke() ?? gained;
    private bool HasGoal => goalQuantity > 0 || goalLevel > 0 || reachWhenBelow;
    private bool GoalReached => (goalQuantity > 0 || reachWhenBelow) &&
        (reachWhenBelow ? GoalProgress <= goalQuantity : GoalProgress >= goalQuantity) ||
        goalLevel > 0 && goalExperience?.Level >= goalLevel;
    private ExperienceComponent? goalExperience;
    private int goalLevel;
    // GameDriver._PhysicsProcess ticks the game independently of its legacy ShouldTick property.
    private bool GamePaused => tree.Paused || driver is null || !driver.CanProcess() || !driver.IsPhysicsProcessing();
    private static Guid? CurrentCharacter => ActiveSaveId?.GetValue(null) as Guid?;

    public void Poll()
    {
        var now = System.Environment.TickCount64;
        if (active is not null && outcome is null)
        {
            try
            {
                if (CurrentCharacter != activeCharacter || !GodotObject.IsInstanceValid(driver) ||
                    !ReferenceEquals(GameProperty?.GetValue(driver), owner))
                    outcome = "action-changed";
                else if (ownsAction?.Invoke() != true) outcome = GoalReached ? "completed" : "action-changed";
                else if (!GamePaused)
                {
                    elapsed += Math.Clamp(now - lastFrame, 0, 250);
                    bool goalMet = GoalReached;
                    if (!goalMet && canProduceGoal?.Invoke() == false)
                        outcome = active.TryStop(false) ? "goal-product-unavailable" : "game-error";
                    else if (goalMet || duration > 0 && elapsed >= duration)
                        outcome = active.TryStop(false) ? (goalMet || !HasGoal ? "completed" : "goal-timeout") : "game-error";
                }
            }
            catch (Exception) { outcome = "game-error"; }
            if (outcome is not null) UntrackItem();
        }
        lastFrame = now;
        if (now < nextPoll) return;
        nextPoll = now + 400;
        if (!File.Exists(requestFile)) return;
        string? id = null;
        string result;
        try
        {
            using var request = JsonDocument.Parse(File.ReadAllBytes(requestFile));
            File.Delete(requestFile);
            var root = request.RootElement;
            id = root.GetProperty("id").GetString();
            var operation = root.GetProperty("operation").GetString();
            result = operation == "hello" ? "connected" : Execute(operation, root);
        }
        catch (Exception)
        {
            if (id is null) return;
            result = "game-error";
        }
        string pending = responseFile + ".tmp";
        try
        {
            File.WriteAllText(pending, JsonSerializer.Serialize(new { id, state = result }), new UTF8Encoding(false));
            File.Move(pending, responseFile, true);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private string Execute(string? operation, JsonElement root)
    {
        if (!GodotObject.IsInstanceValid(driver)) driver = FindDriver(tree.Root);
        if (driver is null || GameProperty?.GetValue(driver) is not GamesByMalcs.Melvor2.Game game ||
            !game.IsSaveLoaded) return operation == "start" ? TryLoadCharacter(root) : "action-changed";
        var requestedLease = root.GetProperty("lease").GetString();
        if (operation is "inspect" or "stop")
        {
            if (lease != requestedLease || !ReferenceEquals(owner, game) || active is null ||
                CurrentCharacter != activeCharacter) return "action-changed";
            if (operation == "inspect")
            {
                if (outcome is not null) return outcome;
                var state = (GamePaused ? "paused:" : "running:") + (duration == 0 ? -1 : Math.Max(0, duration - elapsed));
                if (goalLevel > 0) state += ":" + (goalExperience?.Level ?? 0) + ":" + goalLevel;
                if (goalQuantity > 0 || reachWhenBelow)
                    state += ":" + (long)Math.Clamp(Math.Floor(GoalProgress), 0, int.MaxValue) + ":" + goalQuantity;
                return state;
            }
            if (outcome is "completed" or "goal-timeout" or "goal-product-unavailable") return "stopped";
            if (ownsAction?.Invoke() != true) return "action-changed";
            if (!active.TryStop(false)) return "game-error";
            active = null;
            ownsAction = null;
            lease = null;
            UntrackItem();
            return "stopped";
        }
        if (operation != "start") return "game-error";
        if (root.TryGetProperty("characterId", out var id) && id.ValueKind == JsonValueKind.String)
        {
            if (CurrentCharacter is not Guid saveId ||
                !string.Equals(id.GetString(), Convert.ToHexString(saveId.ToByteArray()),
                StringComparison.OrdinalIgnoreCase)) return "character-mismatch";
        }
        else if (root.GetProperty("character").GetString() != game.CharacterName) return "character-mismatch";
        if (RequestedSaveHash(root) is { } hash)
        {
            if (verifiedSaveHash != hash || verifiedSaveId != CurrentCharacter ||
                (verifiedSaveGame is not null && !ReferenceEquals(verifiedSaveGame, game))) return "save-copy-mismatch";
            verifiedSaveGame = game;
        }
        if (GamePaused) return "paused";
        var skill = root.GetProperty("skill").GetString();
        var target = root.GetProperty("target").GetString();
        if (!root.TryGetProperty("minutes", out var minutes) || !minutes.TryGetInt32(out var runMinutes) ||
            runMinutes < 0 || runMinutes > 1440 || string.IsNullOrEmpty(requestedLease)) return "game-error";
        if (!game.Entities.TryGetObjectById("MelvorBase:" + skill, out var entity) ||
            !entity.Components.TryGetValue("Action", out var component)) return "unsupported";
        var mode = root.TryGetProperty("goal", out var goal) ? goal.GetProperty("type").GetString() : null;
        var experience = mode == "level" && entity.Components.TryGetValue("Experience", out var exp) ?
            exp as ExperienceComponent : null;
        var value = mode is not null ? goal.GetProperty("value").GetInt32() : 0;
        if (mode == "level" && (experience is null || experience.LevelCap < value)) return "invalid-queue";
        if (experience?.Level >= value && value > 0) return "completed";
        var itemId = mode is "item" or "owned" or "spent" or "remaining" ?
            "MelvorBase:" + goal.GetProperty("item").GetString() : null;
        var inventory = game.Entities.TryGetObjectById("MelvorBase:Bank", out var bank) && bank is BankEntity bankEntity
            ? bankEntity.Inventory : null;
        if (itemId is not null && (inventory is null || !inventory.ItemRegistry.TryGetObjectById(itemId, out _)))
            return "invalid-queue";
        if (mode is "item" or "spent" && IsPerformingAction is null) return "game-error";
        if (mode == "recipes" && component is not (CookingActionComponent or ArtisanActionComponent or FiremakingActionComponent))
            return "invalid-queue";
        Func<double>? stock = null;
        if (mode is "owned" or "remaining")
        {
            if (inventory is null || !inventory.ItemRegistry.TryGetObjectById(itemId!, out var item)) return "invalid-queue";
            stock = () => inventory.GetQuantity(item);
            if (mode == "owned" ? stock() >= value : stock() <= value) return "completed";
        }
        Func<bool> goalCanProduce = () => true;
        if (mode is "item" or "owned" && component is ArtisanActionComponent producer)
        {
            var recipe = producer.ActiveRecipes.Values.FirstOrDefault(entry => entry.Recipe.Id == target);
            if (recipe is not null) goalCanProduce = () => CanProduce(producer, recipe, itemId!);
        }
        if (!goalCanProduce()) return "goal-product-unavailable";
        var result = component switch
        {
            WoodcuttingActionComponent wood => StartTree(game, wood, target),
            MiningActionComponent mining => StartRock(game, mining, target),
            FishingActionComponent fishing => StartFishing(game, fishing, target),
            CookingActionComponent cooking => StartRecipe(game, cooking, target,
                cooking.ActiveRecipes.Values, entry => entry.Recipe.Id,
                entry => CanUse(entry.Recipe, entry.Recipe.Category), cooking.CanCreateRecipe,
                entry => { cooking.SelectRecipe(entry); cooking.StartCreating(); }, () => cooking.CreatingRecipe),
            ArtisanActionComponent artisan => StartRecipe(game, artisan, target,
                artisan.ActiveRecipes.Values, entry => entry.Recipe.Id,
                entry => CanUse(entry.Recipe, entry.Recipe.Category), artisan.CanCreateRecipe,
                entry => { artisan.SelectRecipe(entry); artisan.StartCreating(); }, () => artisan.CreatingRecipe),
            FiremakingActionComponent fire => StartRecipe(game, fire, target,
                fire.ActiveRecipes.Values, entry => entry.Recipe.Id,
                entry => CanUse(entry.Recipe, entry.Recipe.Category), fire.CanCreateRecipe,
                entry => { fire.SelectRecipe(entry); fire.StartCreating(); }, () => fire.CreatingRecipe),
            _ => "unsupported"
        };
        if (result == "started")
        {
            UntrackItem();
            lease = requestedLease;
            activeCharacter = CurrentCharacter;
            elapsed = 0;
            duration = runMinutes * 60000;
            outcome = null;
            goalExperience = experience;
            goalLevel = mode == "level" ? value : 0;
            goalQuantity = mode is "item" or "owned" or "spent" or "remaining" or "recipes" ? value : 0;
            goalItem = itemId;
            goalStock = stock;
            canProduceGoal = goalCanProduce;
            reachWhenBelow = mode == "remaining";
            countSpent = mode == "spent";
            gained = 0;
            if (mode is "item" or "spent" && inventory is not null)
            {
                inventory.ItemQuantityChanged += TrackInventory;
                releaseGoal = () => inventory.ItemQuantityChanged -= TrackInventory;
            }
            if (mode == "recipes")
            {
                releaseGoal = component switch
                {
                    CookingActionComponent c => TrackRecipes<ActiveCookingRecipe>(h => c.RecipeCreated += h, h => c.RecipeCreated -= h),
                    ArtisanActionComponent a => TrackRecipes<ActiveArtisanRecipe>(h => a.RecipeCreated += h, h => a.RecipeCreated -= h),
                    FiremakingActionComponent f => TrackRecipes<ActiveFiremakingRecipe>(h => f.RecipeCreated += h, h => f.RecipeCreated -= h),
                    _ => null
                };
            }
        }
        return result;
    }

    private string TryLoadCharacter(JsonElement request)
    {
        if (!request.TryGetProperty("characterId", out var id) || id.ValueKind != JsonValueKind.String ||
            id.GetString() is not string hex || hex.Length != 32 || !hex.All(Uri.IsHexDigit) ||
            !request.TryGetProperty("lease", out var leaseProperty) || leaseProperty.ValueKind != JsonValueKind.String ||
            leaseProperty.GetString() is not string requestedLease || requestedLease.Length == 0)
            return "character-required";
        var selected = new Guid(Convert.FromHexString(hex));
        if (selected == Guid.Empty || CurrentCharacter is not Guid current) return "character-required";
        if (current != Guid.Empty) return current == selected ? "character-loading" : "character-mismatch";
        if (autoLoadLease == requestedLease) return "character-load-failed";
        if (FindNode<SaveSelectPanel>(tree.Root) is not { } menu)
        {
            if (continueLease != requestedLease && ContinueToGame is not null &&
                FindNode<MelvorCloudMenuView>(tree.Root) is { } cloud)
            {
                continueLease = requestedLease;
                ContinueToGame.Invoke(cloud, null);
                return "character-loading";
            }
            return "character-required";
        }
        if (!menu.IsVisibleInTree()) return "character-required";
        if (!SaveManager.StoredSaves.TryGetValue(selected, out var saves)) return "character-not-found";
        var candidates = saves.Saves.Keys.OfType<LocalSaveSource>()
            .OrderByDescending(local => saves.Saves[local].Header.Timestamp);
        var hash = RequestedSaveHash(request);
        LocalSaveSource? source;
        try
        {
            source = hash is null ? candidates.FirstOrDefault() : candidates.FirstOrDefault(local =>
                string.Equals(Convert.ToHexString(SHA256.HashData(local.GetSaveDataForId(selected))), hash,
                    StringComparison.OrdinalIgnoreCase));
        }
        catch (Exception)
        {
            return "character-load-failed";
        }
        if (source is null) return hash is null ? "character-not-found" : "save-copy-mismatch";
        autoLoadLease = requestedLease;
        verifiedSaveId = selected;
        verifiedSaveHash = hash;
        verifiedSaveGame = null;
        menu.SaveSelectedHandler(menu, new SaveSelectedEventArgs(selected, source));
        return "character-loading";
    }

    private static string? RequestedSaveHash(JsonElement request) =>
        request.TryGetProperty("saveHash", out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() : null;

    private Func<bool>? canProduceGoal;

    private static bool CanProduce(ArtisanActionComponent action, ActiveArtisanRecipe recipe, string itemId)
    {
        var normal = recipe.Stats.Products.Values.Any(product => product.Value.Item.Id == itemId &&
            product.Value.Quantity > 0 && product.Value.Chance > 0);
        var mode = recipe.CurrentRewardMode;
        if (mode is null || !mode.ShowAlternativeMode(recipe)) return true;
        if (mode is SacrificialAnvilRewardMode anvil)
            return !normal || anvil.Collectables.Any(drop => drop.Item.Id == itemId && drop.Weight > 0);
        if (mode is AstralOfferingsRewardMode offerings)
        {
            var level = recipe.Requirements.Conditions.OfType<LevelCondition>()
                .FirstOrDefault(condition => condition.Component == action.Experience)?.Level ?? 0;
            return normal || offerings.Rewards.Any(reward => reward.Item.Id == itemId &&
                level >= reward.MinLevel && level <= reward.MaxLevel && reward.Quantity > 0);
        }
        return true;
    }

    private void UntrackItem()
    {
        releaseGoal?.Invoke();
        releaseGoal = null;
    }

    private void TrackInventory(object? sender, ItemQuantityChangedEventArgs args)
    {
        if (args.Item.Id != goalItem || active is null || IsPerformingAction?.Invoke(active) != true ||
            ownsAction?.Invoke() != true) return;
        var delta = countSpent ? -args.QuantityChange : args.QuantityChange;
        if (delta <= 0) return;
        gained += delta;
        if (GoalReached) active.QueueOrTryStop();
    }

    private Action TrackRecipes<T>(Action<EventHandler<CraftingRecipeCreatedEventArgs<T>>> add,
        Action<EventHandler<CraftingRecipeCreatedEventArgs<T>>> remove) where T : IActiveCraftingRecipe
    {
        EventHandler<CraftingRecipeCreatedEventArgs<T>> handler = (_, args) =>
        {
            if (!args.IsSuccess || ownsAction?.Invoke() != true) return;
            gained++;
            if (GoalReached) active?.QueueOrTryStop();
        };
        add(handler);
        return () => remove(handler);
    }

    private string StartTree(GamesByMalcs.Melvor2.Game game, WoodcuttingActionComponent action, string? id)
    {
        var tree = action.Trees.Values.FirstOrDefault(entry => entry.Recipe.Id == id);
        if (tree is null) return "unsupported";
        if (!CanUse(tree.Recipe, tree.Recipe.Category)) return "locked";
        return Start(game, action, () => action.SelectTree(tree), () => ReferenceEquals(action.CuttingTree, tree));
    }

    private string StartRock(GamesByMalcs.Melvor2.Game game, MiningActionComponent action, string? id)
    {
        var rock = action.Rocks.Values.FirstOrDefault(entry => entry.Recipe.Id == id);
        if (rock is null) return "unsupported";
        if (!CanUse(rock.Recipe, rock.Recipe.Category)) return "locked";
        return Start(game, action, () => action.SelectRock(rock), () => ReferenceEquals(action.CurrentRock, rock));
    }

    private string StartFishing(GamesByMalcs.Melvor2.Game game, FishingActionComponent action, string? id)
    {
        foreach (var location in action.Locations.Values)
        {
            var recipe = location.Recipes.FirstOrDefault(entry => entry.Recipe.Id == id);
            if (recipe is null) continue;
            if (!CanUse(recipe.Recipe, location.Location)) return "locked";
            return Start(game, action, () => {
                if (!ReferenceEquals(action.CurrentLocation, location)) action.SetCurrentLocation(location);
                action.SelectRecipe(recipe);
            }, () => ReferenceEquals(action.CurrentRecipe, recipe));
        }
        return "unsupported";
    }

    private string StartRecipe<T>(GamesByMalcs.Melvor2.Game game, ActionComponent action, string? id,
        IEnumerable<T> entries, Func<T, string> recipeId, Func<T, bool> unlocked,
        Func<T, bool> canCreate, Action<T> start, Func<T?> current) where T : class
    {
        var recipe = entries.FirstOrDefault(entry => recipeId(entry) == id);
        if (recipe is null) return "unsupported";
        if (!unlocked(recipe)) return "locked";
        if (!canCreate(recipe)) return "materials";
        return Start(game, action, () => start(recipe), () => ReferenceEquals(current(), recipe));
    }

    private static bool CanUse(params object?[] records)
    {
        foreach (var record in records)
        {
            if (record is null) continue;
            foreach (var property in new[] { "Requirements", "DisplayRequirements", "AccessRequirements",
                "UnlockRequirements", "SecondaryRequirements" })
            {
                if (record.GetType().GetProperty(property)?.GetValue(record) is ConditionGroup gate && !gate.AreMet)
                    return false;
            }
        }
        return true;
    }

    private string Start(GamesByMalcs.Melvor2.Game game, ActionComponent action, Action select, Func<bool> selected)
    {
        bool IsCurrent() => action.IsStarted && selected();
        if (IsCurrent()) return "action-in-use";
        select();
        if (!IsCurrent()) return "game-error";
        owner = game;
        active = action;
        ownsAction = IsCurrent;
        return "started";
    }

    private static GameDriver? FindDriver(Node root) => FindNode<GameDriver>(root);

    private static T? FindNode<T>(Node root) where T : Node
    {
        if (root is T node) return node;
        foreach (var child in root.GetChildren())
        {
            var found = FindNode<T>(child);
            if (found is not null) return found;
        }
        return null;
    }
}
