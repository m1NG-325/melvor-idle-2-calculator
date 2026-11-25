// Build-time only. Run against the original game DLL using Mono.Cecil 0.11.6.
using System;
using System.Linq;
using System.Text.RegularExpressions;
using Mono.Cecil;
using Mono.Cecil.Cil;

internal static class LocalizeRuntime
{
    private static void Main(string[] args)
    {
        using var assembly = AssemblyDefinition.ReadAssembly(args[0]);
        var module = assembly.MainModule;
        var interval = module.GetType("GamesByMalcs.Melvor2.SmartFormatExtensions.IntervalTime.IntervalTimeFormatter")
            .Methods.Single(method => method.Name == "TryEvaluateFormat");
        interval.Body.Instructions.Single(instruction => instruction.OpCode == OpCodes.Ldstr &&
            Equals(instruction.Operand, "s")).Operand = "秒";

        var tab = module.GetType("GamesByMalcs.Melvor2.Entities.Bank.TabButton")
            .Methods.Single(method => method.Name == "UpdateTab");
        var display = tab.Body.Instructions.Single(instruction => instruction.Operand is MethodReference method &&
            method.DeclaringType.FullName == "Godot.Label" && method.Name == "set_Text");
        var replace = typeof(Regex).GetMethod(nameof(Regex.Replace), new[] { typeof(string), typeof(string), typeof(string) })!;
        var il = tab.Body.GetILProcessor();
        il.InsertBefore(display, il.Create(OpCodes.Ldstr, @"^Tab ([0-9]+)$"));
        il.InsertBefore(display, il.Create(OpCodes.Ldstr, "分页 $1"));
        il.InsertBefore(display, il.Create(OpCodes.Call, module.ImportReference(replace)));
        tab.Body.MaxStackSize += 2;
        assembly.Write(args[1]);
    }
}
