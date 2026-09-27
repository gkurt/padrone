#!/usr/bin/env bun
import { createKitchen, pizza } from './pizza.ts';

await pizza.cli({ context: { kitchen: createKitchen() } });
